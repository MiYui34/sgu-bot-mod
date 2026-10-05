import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createAccess } from "../src/auth/access.js";
import { createHandler } from "../src/bot/handle.js";
import { parseRegistration, prefixLabel } from "../src/bot/register.js";
import { startHttp } from "../src/http.js";

test("登记解析正版 ID 和昵称", () => {
	assert.deepEqual(parseRegistration("登记 Steve 小明"), { officialId: "Steve", nickname: "小明" });
	assert.deepEqual(parseRegistration("Alex_1 末影"), { officialId: "Alex_1", nickname: "末影" });
	assert.equal(parseRegistration("Steve"), null);
	assert.equal(parseRegistration("登记 小明 Steve"), null);
	assert.equal(prefixLabel("小明"), "[小明]");
});

test("验证码确认后才放行，并记住正版 ID", async () => {
	const dataDir = await mkdtemp(path.join(tmpdir(), "sgu-access-"));
	let clock = 1_000_000;
	const access = createAccess({ dataDir, now: () => clock });
	const first = access.view("");
	assert.equal(first.body.authorized, false);
	assert.match(first.body.code, /^\d{6}$/);
	assert.equal(first.body.expiresAt, clock + 30_000);
	const cookie = first.cookie.split(";")[0];
	const claimed = access.claim(first.body.code, { memberOpenid: "member-1", username: "小明" });
	assert.equal(claimed.ok, true);
	clock += 121_000;
	assert.equal(access.confirm(claimed.sessionId, "member-1", null), null);
	const again = access.view(cookie);
	const live = access.claim(` ${again.body.code.slice(0, 3)} ${again.body.code.slice(3)} `, {
		memberOpenid: "member-1",
		username: "小明",
	});
	const user = access.confirm(live.sessionId, "member-1", { username: "群名片" });
	assert.equal(user.username, "群名片");
	assert.equal(access.authorized(cookie), true);
	access.rememberName({ memberOpenid: "member-1", username: "群名片" }, { officialId: "Steve", nickname: "小明" });
	assert.equal(access.view(cookie).body.user.minecraftId, "Steve");
	assert.equal(access.view(cookie).body.user.nickname, "小明");
	const stranger = access.claim(access.view("").body.code, { memberOpenid: "member-2", username: "别人" });
	assert.equal(access.confirm(stranger.sessionId, "member-1", null), null);
	await rm(dataDir, { recursive: true, force: true });
});

test("没人再来取的待验证会话会被清掉，也不写进文件", async () => {
	const dataDir = await mkdtemp(path.join(tmpdir(), "sgu-access-"));
	let clock = 1_000_000;
	const access = createAccess({ dataDir, now: () => clock });
	const idle = access.view("").cookie.split(";")[0];
	const bound = access.view("");
	const boundCookie = bound.cookie.split(";")[0];
	const claimed = access.claim(bound.body.code, { memberOpenid: "member-1", username: "小明" });
	access.confirm(claimed.sessionId, "member-1", null);
	clock += 10 * 60_000;
	access.view("");
	const reopened = access.view(idle);
	assert.notEqual(reopened.cookie, "");
	assert.equal(access.authorized(boundCookie), true);
	const saved = JSON.parse(await readFile(path.join(dataDir, "map-access.json"), "utf8"));
	assert.equal(Object.keys(saved.sessions).length, 1);
	await rm(dataDir, { recursive: true, force: true });
});

test("别人登记过的正版 ID 只有本人或管理员能改", async () => {
	const dataDir = await mkdtemp(path.join(tmpdir(), "sgu-access-"));
	const access = createAccess({ dataDir });
	let prefixes = 0;
	const handle = createHandler({
		bridge: { async setPrefix() { prefixes += 1; return { output: "ok" }; } },
		config: { mapPublicUrl: "" },
		auditPath: "",
		access,
	});
	const say = (memberOpenid, role, content) => handle({
		group_openid: "group",
		content,
		author: { member_openid: memberOpenid, member_role: role, username: memberOpenid },
	});
	assert.match((await say("member-1", "member", "登记 Steve 小明")).markdown, /已登记/);
	assert.equal(access.registeredBy("steve"), "member-1");
	assert.match((await say("member-2", "member", "登记 Steve 小红")).markdown, /另一位群成员/);
	assert.match((await say("member-1", "member", "登记 Steve 大明")).markdown, /已登记/);
	assert.match((await say("admin-1", "admin", "登记 Steve 小红")).markdown, /已登记/);
	assert.equal(prefixes, 3);
	await rm(dataDir, { recursive: true, force: true });
});

test("未验证时不提供地图图块", async () => {
	const dataDir = await mkdtemp(path.join(tmpdir(), "sgu-http-"));
	const access = createAccess({ dataDir });
	const server = await startHttp({
		map: {
			watch() {},
			status() {
				return { lastError: "" };
			},
			changesSince() {
				return { revision: 0, tiles: [] };
			},
			async tile() {
				return Buffer.from("webp");
			},
		},
		bridge: { async online() { return { players: [] }; } },
		port: 0,
		access,
	});
	const base = `http://127.0.0.1:${server.port}`;
	const locked = await fetch(`${base}/tiles/overworld/0/0/0.webp`);
	assert.equal(locked.status, 401);
	const session = await fetch(`${base}/api/session`);
	const cookie = session.headers.get("set-cookie").split(";")[0];
	const body = await session.json();
	assert.equal(body.authorized, false);
	const claimed = access.claim(body.code, { memberOpenid: "member-1", username: "小明" });
	access.confirm(claimed.sessionId, "member-1", null);
	const opened = await fetch(`${base}/tiles/overworld/0/0/0.webp`, { headers: { cookie } });
	assert.equal(opened.status, 200);
	await server.close();
	await rm(dataDir, { recursive: true, force: true });
});
