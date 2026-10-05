import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { isAdmin } from "../config.js";
import { parseRegistration, prefixLabel } from "./register.js";

const DIMENSIONS = {
	"minecraft:overworld": "主世界",
	"minecraft:the_nether": "下界",
	"minecraft:the_end": "末地",
};

export function parseCommand(content) {
	let text = String(content || "").replace(/\u00a0/g, " ").trim();
	text = text.replace(/^(?:@\S+\s*)+/, "");
	text = text.replace(/^[／/]+\s*/, "");
	const [head, ...rest] = text.split(/\s+/);
	const arg = rest.join(" ").trim();
	const aliases = {
		假人列表: "假人",
		下线假人: "下线",
		死亡坐标: "死亡",
		执行指令: "执行",
		网页地图: "地图",
		帮助: "帮助",
	};
	return { name: aliases[head] || head || "", arg, raw: text };
}

export function createHandler({ bridge, config, auditPath, access }) {
	return async function handle(event) {
		const group = event.group_openid;
		const role = event.author?.member_role || "member";
		const member = memberOf(event);
		const parsed = parseCommand(messageText(event));
		if (!parsed.name) {
			return null;
		}
		if (access) {
			const compact = parsed.raw.replace(/\s+/g, "");
			if (/^\d{6}$/.test(compact)) {
				const claimed = access.claim(compact, member);
				if (!claimed.ok) return { markdown: claimed.message };
				return {
					markdown: `验证码 \`${compact}\` 已收到。请本人点击确认，把这个网页地图绑到你的 QQ。`,
					keyboard: confirmKeyboard(claimed.sessionId),
				};
			}
		}
		if (parsed.name === "帮助" || parsed.name === "菜单") {
			return { markdown: helpText() };
		}
		if (parsed.name === "地图") {
			return mapReply(config.mapPublicUrl);
		}
		if (parsed.name === "假人" && parsed.arg) {
			try {
				const row = await bridge.lastLogout(parsed.arg);
				if (row.fake === false) {
					return { markdown: `**${escapeMd(row.name || parsed.arg)}** 是真人。发送 \`下线坐标 ${escapeMd(row.name || parsed.arg)}\` 查看下线记录。` };
				}
				return { markdown: formatLogout(row) };
			} catch (error) {
				return { markdown: escapeMd(error.message) };
			}
		}
		if (parsed.name === "假人") {
			const data = await bridge.fakePlayers();
			return { markdown: fakeTable(data.players || []) };
		}
		if (parsed.name === "下线" && !parsed.arg) {
			if (!isAdmin(role)) {
				await audit(auditPath, "deny_role", event, parsed.raw);
				return { markdown: "只有群主或管理员可以下线假人。" };
			}
			const data = await bridge.fakePlayers();
			const online = (data.players || []).filter((player) => player.online);
			return fakeKillPrompt(online);
		}
		if (parsed.name === "下线") {
			if (!isAdmin(role)) {
				await audit(auditPath, "deny_role", event, parsed.raw);
				return { markdown: "只有群主或管理员可以下线假人。" };
			}
			try {
				const result = await bridge.killFake(parsed.arg, member.username || "QQ");
				await audit(auditPath, "kill", event, parsed.raw);
				return { markdown: `已下线假人 **${escapeMd(result.name || parsed.arg)}**。` };
			} catch (error) {
				await audit(auditPath, "kill_fail", event, `${parsed.raw} ${error.message}`);
				return { markdown: escapeMd(error.message) };
			}
		}
		if (parsed.name === "下线坐标" || parsed.name === "死亡") {
			if (!parsed.arg) {
				return { markdown: `用法：\`${parsed.name} 玩家名\`` };
			}
			try {
				const row = parsed.name === "死亡" ? await bridge.lastDeath(parsed.arg) : await bridge.lastLogout(parsed.arg);
				return { markdown: parsed.name === "死亡" ? deathText(row) : formatLogout(row) };
			} catch (error) {
				return { markdown: escapeMd(error.message) };
			}
		}
		if (parsed.name === "执行") {
			if (!isAdmin(role)) {
				await audit(auditPath, "deny_role", event, parsed.raw);
				return { markdown: "只有群主或管理员可以执行服务器指令。" };
			}
			if (!parsed.arg) {
				return { markdown: "用法：`执行 list`" };
			}
			try {
				const result = await bridge.command(parsed.arg);
				await audit(auditPath, "allow", event, parsed.arg);
				const output = String(result.output || "(无输出)").replaceAll("```", "'''").slice(0, 1500);
				return { markdown: `指令已执行：\`${escapeMd(result.command || parsed.arg)}\`\n\n\`\`\`\n${output}\n\`\`\`` };
			} catch (error) {
				await audit(auditPath, error.status === 403 ? "deny_allowlist" : "command_fail", event, `${parsed.arg} ${error.message}`);
				return { markdown: escapeMd(error.message) };
			}
		}
		if (access && parsed.name === "登记") {
			const registration = parseRegistration(parsed.raw);
			if (!registration) {
				return { markdown: "请 @我 发送：`登记 正版ID 服内昵称`，例如 `登记 Steve 小明`。" };
			}
			return registerMember(bridge, access, member, registration);
		}
		if (access?.isPending(member.memberOpenid)) {
			return { markdown: "请 @我 发送：`登记 正版ID 服内昵称`，例如 `登记 Steve 小明`。" };
		}
		return null;
	};
}

function messageText(event) {
	if (event.content && event.content.trim()) {
		return event.content;
	}
	const elements = Array.isArray(event.msg_elements) ? event.msg_elements : [];
	return elements.map((item) => item.content || "").join("\n");
}

function helpText() {
	return [
		"# 服务器助手",
		"",
		"- `假人`：在线假人的召唤人和时间",
		"- `假人 名字`：查这个假人，不在线也能查",
		"- `下线`：管理员用按钮下线假人",
		"- `下线坐标 玩家名`：假人或真人的下线位置、时间、召唤人和下线人，不在线也能查",
		"- `死亡 玩家名`：最近死亡坐标",
		"- `执行 指令`：管理员运行白名单里的指令",
		"- `地图`：打开网页地图",
		"- `登记 正版ID 服内昵称`：设置服内前缀",
	].join("\n");
}

function memberOf(event) {
	const author = event.author || {};
	return {
		memberOpenid: author.member_openid || author.id || "",
		unionOpenid: author.union_openid || "",
		username: author.username || author.nickname || "",
		role: author.member_role || "",
		groupOpenid: event.group_openid || "",
	};
}

function confirmKeyboard(sessionId) {
	return {
		content: {
			rows: [
				{
					buttons: [
						{
							id: "bind",
							render_data: { label: "确认绑定", visited_label: "已确认", style: 1 },
							action: {
								type: 1,
								permission: { type: 2, specify_user_ids: [], specify_role_ids: [] },
								data: `b:${sessionId}`,
								unsupport_tips: "请换用较新的 QQ 客户端确认",
							},
						},
					],
				},
			],
		},
	};
}

async function registerMember(bridge, access, member, registration) {
	if (!member.memberOpenid) {
		return { markdown: "没有读到你的 QQ 身份，没法登记。" };
	}
	const owner = access.registeredBy?.(registration.officialId) || "";
	if (owner && owner !== member.memberOpenid && !isAdmin(member.role)) {
		return { markdown: `**${escapeMd(registration.officialId)}** 已经由另一位群成员登记。需要改的话请找管理员。` };
	}
	try {
		const result = await bridge.setPrefix(registration);
		access.rememberName(member, registration);
		const output = String(result.output || "(无输出)").replaceAll("```", "'''").slice(0, 800);
		const command = result.command || `name other prefix ${registration.officialId} ${prefixLabel(registration.nickname)}`;
		return {
			markdown: `已登记 **${escapeMd(registration.officialId)}**，服内前缀为 ${escapeMd(prefixLabel(registration.nickname))}。\n\n\`${escapeMd(command)}\`\n\n\`\`\`\n${output}\n\`\`\``,
		};
	} catch (error) {
		const message = error.status === 404 ? "游戏模组还是旧版，请换成带登记接口的 sgu-bridge。" : error.message;
		return { markdown: escapeMd(message) };
	}
}

function mapReply(url) {
	const target = String(url || "").trim();
	if (!target) {
		return { markdown: "地图地址还没配置。" };
	}
	if (!/^https:\/\//i.test(target)) {
		return { markdown: `网页地图：\`${target.replaceAll("`", "")}\`` };
	}
	return {
		markdown: "点下面的按钮打开网页地图。",
		keyboard: {
			content: {
				rows: [
					{
						buttons: [
							{
								id: "map",
								render_data: { label: "打开网页地图", visited_label: "打开网页地图", style: 1 },
								action: {
									type: 0,
									permission: { type: 2, specify_user_ids: [], specify_role_ids: [] },
									data: target,
									unsupport_tips: "请换用较新的 QQ 客户端打开",
								},
							},
						],
					},
				],
			},
		},
	};
}

function fakeTable(players) {
	const online = players.filter((player) => player.online);
	if (online.length === 0) {
		return "当前没有在线假人。";
	}
	const lines = ["| 假人 | 召唤人 | 时间 | 位置 |", "| --- | --- | --- | --- |"];
	for (const player of online.slice(0, 20)) {
		lines.push(`| ${cell(player.name)} | ${cell(player.summonerName || "未知")} | ${cell(player.summonedAt || "未知")} | ${cell(place(player))} |`);
	}
	if (online.length > 20) {
		lines.push("", `还有 ${online.length - 20} 个未列出。`);
	}
	return lines.join("\n");
}

function fakeKillPrompt(players) {
	if (players.length === 0) {
		return { markdown: "当前没有在线假人。" };
	}
	const rows = [];
	const shown = players.slice(0, 25);
	for (let i = 0; i < shown.length; i += 5) {
		rows.push({
			buttons: shown.slice(i, i + 5).map((player) => ({
				id: `kill_${player.name}`,
				render_data: {
					label: `下线 ${player.name}`.slice(0, 20),
					visited_label: "已发送",
					style: 1,
				},
				action: {
					type: 2,
					permission: { type: 1, specify_role_ids: [], specify_user_ids: [] },
					data: `下线 ${player.name}`,
					reply: true,
					enter: false,
				},
			})),
		});
	}
	let markdown = "点下面的按钮会生成一条只有管理员能发出的下线指令。";
	if (players.length > shown.length) {
		markdown += `\n还有 ${players.length - shown.length} 个，请发送 \`下线 名字\`。`;
	}
	return { markdown, keyboard: { content: { rows } } };
}

export function formatLogout(row) {
	if (row.kind === "online") {
		const lines = [`**${escapeMd(row.name)}** 仍在线`, place(row)];
		if (row.fake) {
			lines.push(`召唤人：${escapeMd(row.summonerName || "未知")}`);
		}
		if (row.summonedAt) {
			lines.push(`召唤时间：${escapeMd(row.summonedAt)}`);
		}
		return lines.join("\n");
	}
	const title = row.kind === "last_known" ? "最后已知位置" : "最后下线";
	const lines = [
		`**${escapeMd(row.name)}** ${title}`,
		place(row),
		`下线时间：${escapeMd(row.time || "未知")}`,
	];
	if (row.fake) {
		lines.push(`召唤人：${escapeMd(row.summonerName || "未知")}`);
		if (row.summonedAt) {
			lines.push(`召唤时间：${escapeMd(row.summonedAt)}`);
		}
	}
	lines.push(`下线人：${escapeMd(actorLabel(row))}`);
	if (row.kind === "last_known") {
		lines.push("", "这次不是正常下线，多半是服务器在玩家还在线时停了。");
	}
	return lines.join("\n");
}

function actorLabel(row) {
	if (row.actorSource === "self") return "自行下线";
	if (row.actorSource === "server") return "服务器关闭";
	if (row.actorSource === "console") return "控制台";
	if (row.actorSource === "bot") return row.actorName || "机器人";
	if (row.actorSource === "qq") return row.actorName && row.actorName !== "QQ" ? `QQ ${row.actorName}` : "QQ";
	if (row.actorSource === "player" || row.actorSource === "command_block") return row.actorName || "未知";
	return row.actorName || "未知";
}

function deathText(row) {
	const message = row.message ? `\n${escapeMd(row.message)}` : "";
	return `**${escapeMd(row.name)}** 最近死亡\n${place(row)}\n时间：${escapeMd(row.time || "未知")}${message}`;
}

function place(row) {
	const dim = DIMENSIONS[row.dimension] || row.dimension || "未知维度";
	const x = Math.round(Number(row.x) || 0);
	const y = Math.round(Number(row.y) || 0);
	const z = Math.round(Number(row.z) || 0);
	return `${dim} ${x} ${y} ${z}`;
}

function cell(value) {
	return escapeMd(String(value ?? "")).replace(/\|/g, "\\|");
}

function escapeMd(value) {
	return String(value ?? "").replace(/[\\`*_{}[\]()#+\-.!]/g, "\\$&");
}

async function audit(file, result, event, text) {
	if (!file) {
		return;
	}
	await mkdir(path.dirname(file), { recursive: true });
	const author = event.author || {};
	const line = [new Date().toISOString(), result, event.group_openid || "", author.member_openid || author.id || "", author.username || "", text.replace(/\s+/g, " ")].join("\t");
	await appendFile(file, `${line}\n`, "utf8");
}

export function panelItems() {
	return [
		{ type: "command", name: "假人", desc: "查看假人召唤人" },
		{ type: "command", name: "下线", desc: "一键下线假人", only_admin: true },
		{ type: "command", name: "下线坐标", desc: "查下线位置和下线人" },
		{ type: "command", name: "死亡", desc: "查最近死亡坐标" },
		{ type: "command", name: "执行", desc: "运行白名单指令", only_admin: true },
		{ type: "command", name: "网页地图", desc: "打开网页地图" },
	];
}
