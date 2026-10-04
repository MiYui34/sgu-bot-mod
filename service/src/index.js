import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createBridge } from "./bridge.js";
import { createHandler } from "./bot/handle.js";
import { groupAllowed, loadConfig } from "./config.js";
import { startHttp } from "./http.js";
import { syncRegions } from "./map/sync.js";
import { createMap } from "./map/tiles.js";
import { createQq } from "./qq/client.js";
import { startGateway } from "./qq/gateway.js";

await loadEnv();
const config = loadConfig();
const bridge = createBridge(config);
const map = createMap({
	worldPath: config.worldPath,
	cacheDir: path.join(config.dataDir, "tiles"),
});
const handle = createHandler({
	bridge,
	config,
	auditPath: path.join(config.dataDir, "audit.log"),
});

const sequences = new Map();
const recentReplies = new Map();

let lastRefresh = 0;
let refreshing = false;
let regionSyncUnsupported = false;

setInterval(() => {
	if (!map.watching() || refreshing || Date.now() - lastRefresh < 300000) {
		return;
	}
	refreshing = true;
	lastRefresh = Date.now();
	refreshMap().catch((error) => {
		console.error(`地图同步失败：${error.message}`);
		lastRefresh = Date.now() - 240000;
	}).finally(() => {
		refreshing = false;
	});
}, 5000);

async function refreshMap() {
	if (!regionSyncUnsupported) {
		try {
			const result = await syncRegions(bridge, config.worldPath);
			for (const file of result.files) {
				map.notifyRegionFile(file.dim, file.name);
			}
			if (result.updated > 0) {
				console.log(`区域同步：写入 ${result.updated} 个文件，${result.bytes} 字节`);
			}
		} catch (error) {
			if (error.status === 404) {
				regionSyncUnsupported = true;
				console.error("模组没有区域同步接口，请换成新的 sgu-bridge");
			} else {
				throw error;
			}
		}
	}
	await map.poll();
}

const httpServer = await startHttp({ map, bridge, port: config.httpPort });
console.log(`网页地图 http://127.0.0.1:${httpServer.port}/`);
console.log(`世界目录 ${config.worldPath}`);

if (!config.appId || !config.appSecret) {
	console.log("未配置 APP_ID / APP_SECRET，QQ 机器人未启动");
} else {
	const qq = createQq(config);
	startGateway({
		qq,
		config,
		async onGroupMessage(event) {
			if (!groupAllowed(config, event.group_openid)) {
				console.log(`忽略未允许的群 ${event.group_openid}`);
				return;
			}
			if (repeatedReply(event)) {
				console.log("忽略重复的群消息");
				return;
			}
			let result;
			try {
				result = await handle(event);
			} catch (error) {
				result = { markdown: error.message || "查询失败" };
			}
			if (!result) {
				result = { markdown: "没看懂。发送 `帮助` 查看指令。" };
			}
			const seq = (sequences.get(event.id) || 0) + 1;
			sequences.set(event.id, seq);
			const body = {
				msg_type: 2,
				msg_id: event.id,
				msg_seq: seq,
				markdown: { content: result.markdown },
			};
			if (result.keyboard) {
				body.keyboard = result.keyboard;
			}
			try {
				await qq.api("POST", `/v2/groups/${event.group_openid}/messages`, body);
			} catch (error) {
				console.error(`回复群消息失败：${error.message}`);
			}
		},
	});
}

function repeatedReply(event) {
	const author = event.author?.member_openid || event.author?.id || "";
	const text = eventText(event).replace(/\s+/g, " ").trim();
	const key = `${event.group_openid}|${author}|${text}`;
	const now = Date.now();
	for (const [item, time] of recentReplies) {
		if (now - time > 5000) {
			recentReplies.delete(item);
		}
	}
	if (recentReplies.has(key)) {
		return true;
	}
	recentReplies.set(key, now);
	return false;
}

function eventText(event) {
	const content = String(event.content || "").trim();
	if (content) {
		return content;
	}
	const elements = Array.isArray(event.msg_elements) ? event.msg_elements : [];
	return elements.map((item) => item.content || "").join("\n");
}

async function loadEnv() {
	try {
		const file = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", ".env");
		const text = await readFile(file, "utf8");
		for (const line of text.split(/\r?\n/)) {
			const trimmed = line.trim();
			if (!trimmed || trimmed.startsWith("#")) {
				continue;
			}
			const eq = trimmed.indexOf("=");
			if (eq < 0) {
				continue;
			}
			const key = trimmed.slice(0, eq).trim();
			let value = trimmed.slice(eq + 1).trim();
			if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
				value = value.slice(1, -1);
			}
			if (process.env[key] === undefined) {
				process.env[key] = value;
			}
		}
	} catch {
		// 没有 .env 时完全靠环境变量。
	}
}
