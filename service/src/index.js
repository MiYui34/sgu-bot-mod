import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createAccess } from "./auth/access.js";
import { createBridge } from "./bridge.js";
import { createBridgeLink } from "./bridge-link.js";
import { createHandler } from "./bot/handle.js";
import { groupAllowed, loadConfig } from "./config.js";
import { startHttp } from "./http.js";
import { preloadActive, preloadLockPath } from "./map/preload-lock.js";
import { regionPath, syncRegions } from "./map/sync.js";
import { createRegionFetcher, priorityPending } from "./map/fetch-region.js";
import { createMap } from "./map/tiles.js";
import { encodeLosslessWebp } from "./map/webp.js";
import { createQq } from "./qq/client.js";
import { startGateway } from "./qq/gateway.js";
import { sendIncreasing } from "./qq/msg-seq.js";

await loadEnv();
const config = loadConfig();
const link = createBridgeLink();
const bridge = createBridge(config, fetch, link);
let regionManifest = { files: {} };
let manifestPath = "";

const preloadLock = preloadLockPath(config.dataDir);
const map = createMap({
	worldPath: config.worldPath,
	cacheDir: path.join(config.dataDir, "tiles"),
	preloadLock,
	ensureRegion: createRegionFetcher(bridge, config.worldPath),
	preferRemote: () => link.mapConnected(),
	requestTile(dim, tileX, tileZ) {
		try {
			link.needTiles([{ dim, x: tileX, z: tileZ }]);
		} catch {
			// 地图连接刚断开时，下一次打开这块图再要。
		}
	},
	releaseRegion: (dim, tileX, tileZ) => releaseRenderedRegion(dim, tileX, tileZ),
});
link.setTileHandler(async (tile) => {
	try {
		const body = tile.pixels
			? await encodeLosslessWebp(tile.pixels, 256, 256, 0)
			: tile.body;
		await map.acceptUpload(tile.dim, tile.tileX, tile.tileZ, body);
	} catch (error) {
		console.error(`地图图块保存失败：${error.message}`);
	}
});
const access = createAccess({ dataDir: config.dataDir });
const handle = createHandler({
	bridge,
	config,
	auditPath: path.join(config.dataDir, "audit.log"),
	access,
});

const sequences = new Map();
const recentReplies = new Map();

let lastRefresh = 0;
let refreshing = false;
let regionSyncUnsupported = false;
let loggedPreload = false;

function scheduleRefresh() {
	if (regionSyncUnsupported || refreshing) {
		return;
	}
	refreshing = true;
	refreshMap().catch((error) => {
		console.error(`地图同步失败：${error.message}`);
		lastRefresh = Date.now() - 240000;
	}).finally(() => {
		refreshing = false;
	});
}

const bootedAt = Date.now();

setInterval(() => {
	if (!map.watching() || Date.now() - bootedAt < 20000 || Date.now() - lastRefresh < 300000) {
		return;
	}
	scheduleRefresh();
}, 5000);

async function refreshMap() {
	if (await preloadActive(preloadLock)) {
		if (!loggedPreload) {
			loggedPreload = true;
			console.log("全量加载进行中，暂停区域同步");
		}
		return;
	}
	loggedPreload = false;
	lastRefresh = Date.now();
	if (link.mapConnected()) {
		return;
	}
	if (!regionSyncUnsupported) {
		const markerPath = path.join(config.dataDir, "map-world.json");
		manifestPath = path.join(config.dataDir, "region-index.json");
		const marker = await readMarker(markerPath);
		regionManifest = await readManifest(manifestPath);
		try {
			const result = await syncRegions(bridge, config.worldPath, {
				manifest: regionManifest,
				previousWorld: marker.world || "",
				discard: false,
				yieldToPriority: priorityPending,
				tilesReady: (dim, name) => map.regionCached(dim, name),
				onWorldChange: () => map.resetCache(),
				onRegion: (file) => map.notifyRegionFile(file.dim, file.name),
			});
			if (!result.worldChanged) {
				for (const file of result.removed) {
					await map.forgetRegion(file.dim, file.name);
				}
			}
			await writeMarker(markerPath, { world: result.world || marker.world || "", epoch: 2 });
			if (result.released > 0) {
				console.log(`已删除云端区域副本，释放 ${formatBytes(result.released)}`);
			}
			if (result.updated > 0 || result.removed.length > 0) {
				console.log(`区域同步：更新 ${result.updated} 个，移除 ${result.removed.length} 个，下载 ${formatBytes(result.bytes)}`);
			}
		} catch (error) {
			if (error.status === 404) {
				regionSyncUnsupported = true;
				console.error("模组没有区域同步接口，请换成新的 sgu-bridge");
			} else {
				throw error;
			}
		} finally {
			await writeManifest(manifestPath, regionManifest);
		}
	}
	await map.poll();
}

const httpServer = await startHttp({ map, bridge, port: config.httpPort, access, link, bridgeToken: config.bridgeToken });
console.log(`网页地图 http://127.0.0.1:${httpServer.port}/`);
console.log(`世界目录 ${config.worldPath}`);
setTimeout(scheduleRefresh, 20000);

if (!config.appId || !config.appSecret) {
	console.log("未配置 APP_ID / APP_SECRET，QQ 机器人未启动");
} else {
	const qq = createQq(config);
	startGateway({
		qq,
		config,
		async onMemberAdd(event, eventId) {
			if (!groupAllowed(config, event.group_openid)) return;
			access.notePending(event);
			const content = "欢迎加入。请 @我 发送「登记 正版ID 服内昵称」，例如：登记 Steve 小明。登记后会把服内前缀设为 [小明]。";
			const welcomeKey = eventId || event.group_openid;
			try {
				await sendIncreasing(sequences, welcomeKey, (seq) => sendGroup(qq, event.group_openid, { msg_type: 0, content, event_id: eventId, msg_seq: seq }));
			} catch (error) {
				const code = Number(error.code || error.data?.err_code || error.data?.code || 0);
				if (code !== 40034025 && code !== 40034026 && code !== 40034027) {
					console.error(`欢迎新成员失败：${error.message}`);
					return;
				}
				try {
					await sendIncreasing(sequences, `${welcomeKey}:plain`, (seq) => sendGroup(qq, event.group_openid, { msg_type: 0, content, msg_seq: seq }));
				} catch (again) {
					console.error(`欢迎新成员失败：${again.message}`);
				}
			}
		},
		async onInteraction(event, eventId) {
			if (Number(event.type) !== 11) return;
			const button = event.data?.resolved?.button_data || "";
			const memberOpenid = event.group_member_openid || "";
			let code = 0;
			let user = null;
			if (!button.startsWith("b:") || event.scene !== "group") {
				code = 0;
			} else {
				user = access.confirm(button.slice(2), memberOpenid, null);
				code = user ? 0 : 4;
			}
			try {
				await qq.api("PUT", `/interactions/${event.id}`, { code });
			} catch (error) {
				console.error(`确认按钮回应失败：${error.message}`);
			}
			if (!user || !event.group_openid) return;
			let profile = null;
			try {
				profile = await qq.api("GET", `/v2/groups/${event.group_openid}/members/${memberOpenid}`);
			} catch {
				profile = null;
			}
			if (profile?.username) {
				user = access.applyProfile(memberOpenid, profile) || user;
			}
			const name = user.username || "你";
			try {
				const bindKey = eventId || event.id;
				await sendIncreasing(sequences, bindKey, (seq) => sendGroup(qq, event.group_openid, {
					msg_type: 2,
					markdown: { content: `已把网页地图绑定给 **${name.replace(/[\\`*_{}[\]()#+\-.!]/g, "\\$&")}**。` },
					event_id: bindKey,
					msg_seq: seq,
				}));
			} catch (error) {
				console.error(`绑定结果发送失败：${error.message}`);
			}
		},
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
				result = { markdown: "未知指令，发送 `帮助` 查看指令。" };
			}
			try {
				await sendIncreasing(sequences, event.id, (seq) => {
					const body = {
						msg_type: 2,
						msg_id: event.id,
						msg_seq: seq,
						markdown: { content: result.markdown },
					};
					if (result.keyboard) {
						body.keyboard = result.keyboard;
					}
					return qq.api("POST", `/v2/groups/${event.group_openid}/messages`, body);
				});
			} catch (error) {
				console.error(`回复群消息失败：${error.message}`);
			}
		},
	});
}

async function sendGroup(qq, groupOpenid, body) {
	await qq.api("POST", `/v2/groups/${groupOpenid}/messages`, body);
}

function repeatedReply(event) {
	const author = event.author?.member_openid || event.author?.id || "";
	const text = eventText(event).replace(/\s+/g, " ").trim();
	const key = `${event.group_openid}|${author}|${text}`;
	const now = Date.now();
	for (const [item, time] of recentReplies) {
		// 同一条群消息可能在模组重连完成前被再投递一次。
		if (now - time > 12000) {
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

async function releaseRenderedRegion(dim, tileX, tileZ) {
	if (await preloadActive(preloadLock)) {
		return;
	}
	const regionX = Math.floor((tileX * 16) / 32);
	const regionZ = Math.floor((tileZ * 16) / 32);
	const name = `r.${regionX}.${regionZ}.mca`;
	if (!map.regionSettled(dim, name) || !(await map.regionCached(dim, name))) {
		return;
	}
	const dest = regionPath(config.worldPath, dim, name);
	if (!dest) {
		return;
	}
	const info = await stat(dest).catch(() => null);
	if (!info) {
		return;
	}
	regionManifest.files[`${dim}/${name}`] = { size: info.size, mtime: info.mtimeMs };
	await rm(dest, { force: true });
	saveManifestSoon();
}

let manifestTimer = null;
let manifestDirty = false;

function saveManifestSoon() {
	manifestDirty = true;
	if (manifestTimer || !manifestPath) {
		return;
	}
	manifestTimer = setTimeout(async () => {
		manifestTimer = null;
		if (!manifestDirty || !manifestPath) {
			return;
		}
		manifestDirty = false;
		try {
			await writeManifest(manifestPath, regionManifest);
		} catch (error) {
			manifestDirty = true;
			console.error(`区域索引保存失败：${error.message}`);
		}
		if (manifestDirty) {
			saveManifestSoon();
		}
	}, 2000);
}

function formatBytes(bytes) {
	if (bytes >= 1024 * 1024 * 1024) {
		return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
	}
	if (bytes >= 1024 * 1024) {
		return `${Math.round(bytes / (1024 * 1024))} MB`;
	}
	return `${bytes} 字节`;
}

async function readManifest(file) {
	try {
		const parsed = JSON.parse(await readFile(file, "utf8"));
		return { files: parsed.files && typeof parsed.files === "object" ? parsed.files : {} };
	} catch {
		return { files: {} };
	}
}

async function writeManifest(file, manifest) {
	await mkdir(path.dirname(file), { recursive: true });
	const temporary = `${file}.${process.pid}.tmp`;
	await writeFile(temporary, JSON.stringify(manifest));
	try {
		await rename(temporary, file);
	} catch (error) {
		if (error.code !== "EPERM" && error.code !== "EEXIST") {
			throw error;
		}
		await rm(file, { force: true });
		await rename(temporary, file);
	}
}

async function readMarker(file) {
	try {
		const parsed = JSON.parse(await readFile(file, "utf8"));
		return {
			world: typeof parsed.world === "string" ? parsed.world : "",
			epoch: Number(parsed.epoch) || 0,
		};
	} catch {
		return { world: "", epoch: 0 };
	}
}

async function writeMarker(file, marker) {
	await mkdir(path.dirname(file), { recursive: true });
	const temporary = `${file}.${process.pid}.tmp`;
	await writeFile(temporary, JSON.stringify(marker));
	try {
		await rename(temporary, file);
	} catch (error) {
		if (error.code !== "EPERM" && error.code !== "EEXIST") {
			throw error;
		}
		await rm(file, { force: true });
		await rename(temporary, file);
	}
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
