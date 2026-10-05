import { randomBytes, randomInt } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";

const COOKIE = "sgu_map";
const CODE_MS = 30_000;
const CLAIM_MS = 120_000;
const PENDING_MS = 7 * 24 * 60 * 60 * 1000;
const SWEEP_MS = 60_000;

export function createAccess({ dataDir, now = () => Date.now() }) {
	const file = path.join(dataDir, "map-access.json");
	const sessions = new Map();
	const codes = new Map();
	const members = new Map();
	const pending = new Map();
	load();

	function load() {
		let saved = {};
		try {
			saved = JSON.parse(readFileSync(file, "utf8"));
		} catch {
			saved = {};
		}
		for (const [id, row] of Object.entries(saved.sessions || {})) {
			if (!/^[a-f0-9]{32}$/.test(id) || !row?.bound) continue;
			sessions.set(id, { id, bound: row.bound, code: "", codeExpires: 0, claim: null });
		}
		for (const [id, row] of Object.entries(saved.members || {})) {
			members.set(id, row);
		}
		for (const [id, row] of Object.entries(saved.pending || {})) {
			if (row?.at && now() - row.at < PENDING_MS) pending.set(id, row);
		}
	}

	function persist() {
		const body = {
			sessions: Object.fromEntries([...sessions].filter(([, session]) => session.bound).map(([id, session]) => [id, { bound: session.bound }])),
			members: Object.fromEntries(members),
			pending: Object.fromEntries(pending),
		};
		mkdirSync(dataDir, { recursive: true });
		const temporary = `${file}.${process.pid}.tmp`;
		writeFileSync(temporary, JSON.stringify(body));
		renameSync(temporary, file);
	}

	function issue(session) {
		if (session.code && session.codeExpires > now()) return;
		if (session.code) codes.delete(session.code);
		let code = "";
		do {
			code = String(randomInt(0, 1_000_000)).padStart(6, "0");
		} while (codes.has(code));
		session.code = code;
		session.codeExpires = now() + CODE_MS;
		codes.set(code, session.id);
	}

	function ensureSession(id) {
		let session = sessions.get(id);
		if (!session) {
			session = { id, bound: null, code: "", codeExpires: 0, claim: null };
			sessions.set(id, session);
		}
		return session;
	}

	// 每个没带 cookie 的请求都会开一个待验证会话；关掉页面后没人再来取，得定期清掉。
	let sweptAt = 0;
	function sweep() {
		const current = now();
		if (current - sweptAt < SWEEP_MS) return;
		sweptAt = current;
		for (const [id, session] of sessions) {
			if (session.bound) continue;
			if (session.codeExpires + CLAIM_MS > current) continue;
			if (session.claim && session.claim.expires > current) continue;
			if (session.code) codes.delete(session.code);
			sessions.delete(id);
		}
	}

	function view(cookieHeader) {
		sweep();
		let id = readCookie(cookieHeader, COOKIE);
		let created = false;
		if (!id || !sessions.has(id)) {
			id = randomBytes(16).toString("hex");
			created = true;
		}
		const session = ensureSession(id);
		if (!session.bound) issue(session);
		return {
			cookie: created ? cookieFor(id) : "",
			body: session.bound
				? { authorized: true, user: publicUser(session.bound) }
				: { authorized: false, code: session.code, expiresAt: session.codeExpires },
		};
	}

	function authorized(cookieHeader) {
		const id = readCookie(cookieHeader, COOKIE);
		return Boolean(id && sessions.get(id)?.bound);
	}

	function claim(code, member) {
		const normalized = String(code || "").replace(/\D/g, "");
		const id = codes.get(normalized);
		const session = id ? sessions.get(id) : null;
		if (!session || session.bound || !session.codeExpires || session.codeExpires <= now() || session.code !== normalized) {
			return { ok: false, message: "验证码无效或已过期，请看网页上的新验证码。" };
		}
		if (!member?.memberOpenid) {
			return { ok: false, message: "没有读到你的 QQ 身份，没法绑定网页。" };
		}
		if (session.claim && session.claim.expires > now() && session.claim.memberOpenid !== member.memberOpenid) {
			return { ok: false, message: "这个验证码正在等对方确认。" };
		}
		session.claim = {
			memberOpenid: member.memberOpenid,
			unionOpenid: member.unionOpenid || "",
			username: member.username || "",
			role: member.role || "",
			groupOpenid: member.groupOpenid || "",
			expires: now() + CLAIM_MS,
		};
		return { ok: true, sessionId: session.id };
	}

	function confirm(sessionId, memberOpenid, profile) {
		const session = sessions.get(sessionId);
		const owner = session?.claim?.memberOpenid || "";
		const samePerson = owner === memberOpenid || (session?.claim?.unionOpenid && session.claim.unionOpenid === memberOpenid);
		if (!session?.claim || session.claim.expires <= now() || !samePerson) {
			return null;
		}
		const known = members.get(owner) || {};
		const bound = {
			memberOpenid: owner,
			username: profile?.username || session.claim.username || known.username || "",
			role: profile?.member_role || session.claim.role || known.role || "",
			unionOpenid: profile?.union_openid || known.unionOpenid || "",
			minecraftId: known.minecraftId || "",
			nickname: known.nickname || "",
		};
		session.bound = bound;
		if (session.code) codes.delete(session.code);
		session.code = "";
		session.codeExpires = 0;
		session.claim = null;
		members.set(owner, {
			...known,
			memberOpenid: owner,
			username: bound.username,
			role: bound.role,
			unionOpenid: bound.unionOpenid,
			groupOpenid: known.groupOpenid || "",
		});
		persist();
		return publicUser(bound);
	}

	function applyProfile(memberOpenid, profile) {
		if (!memberOpenid || !profile) return null;
		const known = members.get(memberOpenid) || {};
		const next = {
			...known,
			memberOpenid,
			username: profile.username || known.username || "",
			role: profile.member_role || known.role || "",
			unionOpenid: profile.union_openid || known.unionOpenid || "",
		};
		members.set(memberOpenid, next);
		let user = null;
		for (const session of sessions.values()) {
			if (session.bound?.memberOpenid !== memberOpenid) continue;
			session.bound = {
				...session.bound,
				username: next.username,
				role: next.role,
				unionOpenid: next.unionOpenid,
			};
			user = publicUser(session.bound);
		}
		persist();
		return user;
	}

	function notePending(event) {
		if (!event?.member_openid || !event?.group_openid) return;
		pending.set(event.member_openid, { groupOpenid: event.group_openid, at: now() });
		persist();
	}

	function isPending(memberOpenid) {
		const row = pending.get(memberOpenid);
		if (!row) return false;
		if (now() - row.at >= PENDING_MS) {
			pending.delete(memberOpenid);
			return false;
		}
		return true;
	}

	function rememberName(member, registration) {
		const previous = members.get(member.memberOpenid) || {};
		const next = {
			...previous,
			memberOpenid: member.memberOpenid,
			username: member.username || previous.username || "",
			role: member.role || previous.role || "",
			groupOpenid: member.groupOpenid || previous.groupOpenid || "",
			minecraftId: registration.officialId,
			nickname: registration.nickname,
		};
		members.set(member.memberOpenid, next);
		pending.delete(member.memberOpenid);
		for (const session of sessions.values()) {
			if (session.bound?.memberOpenid === member.memberOpenid) {
				session.bound = {
					...session.bound,
					username: next.username || session.bound.username,
					minecraftId: registration.officialId,
					nickname: registration.nickname,
				};
			}
		}
		persist();
	}

	function registeredBy(officialId) {
		const wanted = String(officialId || "").toLowerCase();
		if (!wanted) return "";
		for (const [memberOpenid, row] of members) {
			if (String(row?.minecraftId || "").toLowerCase() === wanted) return memberOpenid;
		}
		return "";
	}

	return { view, authorized, claim, confirm, applyProfile, notePending, isPending, rememberName, registeredBy };
}

export function readCookie(header, name) {
	const source = String(header || "");
	for (const part of source.split(";")) {
		const eq = part.indexOf("=");
		if (eq < 0) continue;
		if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
	}
	return "";
}

function cookieFor(id) {
	return `${COOKIE}=${id}; Path=/; HttpOnly; SameSite=Lax; Max-Age=31536000`;
}

function publicUser(bound) {
	return {
		username: bound.username || "",
		role: bound.role || "",
		minecraftId: bound.minecraftId || "",
		nickname: bound.nickname || "",
	};
}
