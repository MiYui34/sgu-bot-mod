import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { constants, setPriority } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { WebSocket } from "ws";
import { encodeTileFrame } from "../src/bridge-link.js";
import { loadConfig } from "../src/config.js";
import { DIMENSIONS } from "../src/map/render.js";
import { createPushPool } from "../src/map/push-pool.js";
import {
	acceptNeed,
	bridgeSocketUrl,
	chunksForTile,
	createSendLimiter,
	parseRegion,
	pullNext,
	sameStamp,
	tileKey,
	tilesForRegion,
	uploadBytesPerSecond,
	workerCount,
} from "../src/map/push-plan.js";
import { regionPath } from "../src/map/sync.js";

const SCAN_MS = 5000;

async function main() {
	try {
		const priority = constants.priority.PRIORITY_BELOW_NORMAL ?? constants.priority.PRIORITY_LOW;
		setPriority(priority);
	} catch {
		// 没有权限调整优先级时，仍把绘制留在独立线程里。
	}
	await loadEnv();
	const config = loadConfig();
	const cloud = bridgeSocketUrl(process.env.CLOUD_URL || process.env.MAP_PUBLIC_URL || "");
	if (!cloud || !config.bridgeToken) {
		console.error("请在游戏机上设置 CLOUD_URL 和 BRIDGE_TOKEN");
		process.exit(1);
	}
	const jobs = workerCount();
	const bytesPerSecond = uploadBytesPerSecond();
	const state = createUploader({
		worldPath: config.worldPath,
		cloud,
		token: config.bridgeToken,
		jobs,
		bytesPerSecond,
		manifestPath: path.join(config.dataDir, "push-stamps.json"),
	});
	process.on("SIGINT", () => {
		state.stop().finally(() => process.exit(0));
	});
	await state.start();
}

export function createUploader(options) {
	const jobs = options.jobs;
	const pool = createPushPool(jobs);
	const waitFor = options.waitFor || createSendLimiter(options.bytesPerSecond);
	const inflight = new Map();
	const waiting = [];
	const outbound = [];
	const regionJobs = new Map();
	let manifest = { regions: {} };
	let socket = null;
	let authed = false;
	let sending = false;
	let scanning = false;
	let stopped = false;
	let delay = 1000;
	let scanTimer = null;
	let saveTimer = null;

	async function start() {
		manifest = await readManifest(options.manifestPath);
		pool.start();
		console.log(`开始上传地形图，${jobs} 路绘制，上传限制 ${Math.round((options.bytesPerSecond * 8) / 1000000)}Mbps`);
		connect();
		await scan();
		scanTimer = setInterval(() => {
			scan().catch((error) => console.error(`查看区域失败：${error.message}`));
		}, SCAN_MS);
	}

	function connect() {
		if (stopped) {
			return;
		}
		const next = new WebSocket(options.cloud);
		socket = next;
		next.on("open", () => {
			delay = 1000;
			next.send(JSON.stringify({ op: "auth", token: options.token, role: "map" }));
		});
		next.on("message", (data, isBinary) => {
			if (isBinary) {
				return;
			}
			let message;
			try {
				message = JSON.parse(data.toString());
			} catch {
				return;
			}
			if (message.op === "auth" && message.ok) {
				authed = true;
				console.log("地图上传已连接");
				pumpSend();
				return;
			}
			for (const tile of acceptNeed(message)) {
				enqueue(tile, true, "");
			}
		});
		next.on("close", () => {
			if (socket !== next) {
				return;
			}
			authed = false;
			socket = null;
			if (stopped) {
				return;
			}
			console.log("地图上传已断开，正在重连");
			setTimeout(connect, delay).unref?.();
			delay = Math.min(delay * 2, 30000);
		});
		next.on("error", (error) => {
			console.error(`地图上传连接失败：${error.message}`);
		});
	}

	async function scan() {
		if (scanning || stopped) {
			return;
		}
		scanning = true;
		try {
			for (const dim of Object.keys(DIMENSIONS)) {
				const dir = path.join(options.worldPath, ...DIMENSIONS[dim]);
				let names = [];
				try {
					names = await readdir(dir);
				} catch {
					continue;
				}
				for (const name of names) {
					if (!parseRegion(name)) {
						continue;
					}
					const file = regionPath(options.worldPath, dim, name);
					const info = await stat(file).catch(() => null);
					if (!info || info.size < 8192) {
						continue;
					}
					const key = `${dim}/${name}`;
					if (sameStamp(manifest.regions[key], info.size, info.mtimeMs)) {
						continue;
					}
					watchRegion(dim, name, info.size, info.mtimeMs);
				}
			}
		} finally {
			scanning = false;
		}
	}

	function watchRegion(dim, name, size, mtime) {
		const region = parseRegion(name);
		if (!region) {
			return;
		}
		const jobId = `${dim}/${name}@${size}@${mtime}`;
		if (regionJobs.has(jobId)) {
			return;
		}
		for (const key of regionJobs.keys()) {
			if (key.startsWith(`${dim}/${name}@`)) {
				regionJobs.delete(key);
			}
		}
		const tiles = tilesForRegion(dim, region.regionX, region.regionZ);
		regionJobs.set(jobId, new Set(tiles.map((tile) => tileKey(tile))));
		for (const tile of tiles) {
			enqueue(tile, false, jobId);
		}
	}

	function enqueue(tile, urgent, jobId) {
		const key = tileKey(tile);
		const current = inflight.get(key);
		if (current) {
			if (urgent) {
				current.urgent = true;
				const index = waiting.indexOf(current);
				if (index > 0) {
					waiting.splice(index, 1);
					waiting.unshift(current);
				}
			}
			if (jobId) {
				current.jobId = jobId;
			}
			return;
		}
		const record = { key, ...tile, urgent: Boolean(urgent), jobId: jobId || "" };
		inflight.set(key, record);
		if (urgent) {
			waiting.unshift(record);
		} else {
			waiting.push(record);
		}
		pumpRender();
	}

	let rendering = 0;

	function pumpRender() {
		while (rendering < jobs) {
			const next = waiting.shift();
			if (!next) {
				return;
			}
			rendering += 1;
			pool.render({
				worldPath: options.worldPath,
				dim: next.dim,
				chunks: chunksForTile(next.tileX, next.tileZ),
			}, { urgent: next.urgent }).then((body) => {
				next.body = body;
				outbound.push(next);
				pumpSend();
			}).catch((error) => {
				console.error(`绘制失败 ${next.dim} ${next.tileX},${next.tileZ}：${error.message}`);
				inflight.delete(next.key);
				setTimeout(() => {
					if (!stopped) {
						enqueue(next, next.urgent, next.jobId);
					}
				}, 5000).unref?.();
			}).finally(() => {
				rendering -= 1;
				pumpRender();
			});
		}
	}

	function pumpSend() {
		if (sending) {
			return;
		}
		sending = true;
		step().finally(() => {
			sending = false;
			if (outbound.length > 0 && authed) {
				pumpSend();
			}
		});
	}

	async function step() {
		while (outbound.length > 0 && authed && socket?.readyState === 1) {
			const item = pullNext(outbound);
			const wait = waitFor(item.body?.byteLength || item.body?.length || 0, item.urgent);
			if (wait > 0) {
				outbound.unshift(item);
				await delayMs(wait);
				continue;
			}
			if (!authed || socket?.readyState !== 1) {
				outbound.unshift(item);
				return;
			}
			try {
				await sendFrame(socket, encodeTileFrame(item.dim, item.tileX, item.tileZ, item.body));
			} catch (error) {
				outbound.unshift(item);
				console.error(`上传图块失败：${error.message}`);
				return;
			}
			inflight.delete(item.key);
			complete(item);
		}
	}

	function complete(item) {
		if (!item.jobId) {
			return;
		}
		const waiting = regionJobs.get(item.jobId);
		if (!waiting) {
			return;
		}
		waiting.delete(item.key);
		if (waiting.size > 0) {
			return;
		}
		regionJobs.delete(item.jobId);
		const split = item.jobId.split("@");
		const mtime = Number(split.pop());
		const size = Number(split.pop());
		const regionKey = split.join("@");
		manifest.regions[regionKey] = { size, mtime };
		saveSoon();
	}

	function saveSoon() {
		if (saveTimer) {
			return;
		}
		saveTimer = setTimeout(() => {
			saveTimer = null;
			writeManifest(options.manifestPath, manifest).catch((error) => {
				console.error(`进度保存失败：${error.message}`);
			});
		}, 1000);
		saveTimer.unref?.();
	}

	async function stop() {
		stopped = true;
		if (scanTimer) {
			clearInterval(scanTimer);
		}
		if (saveTimer) {
			clearTimeout(saveTimer);
		}
		socket?.close();
		await writeManifest(options.manifestPath, manifest);
		await pool.stop();
	}

	return { start, stop, enqueue, inflight, outbound };
}

function sendFrame(socket, frame) {
	return new Promise((resolve, reject) => {
		socket.send(frame, (error) => {
			if (error) {
				reject(error);
				return;
			}
			resolve();
		});
	});
}

function delayMs(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

async function readManifest(file) {
	try {
		const parsed = JSON.parse(await readFile(file, "utf8"));
		return { regions: parsed.regions && typeof parsed.regions === "object" ? parsed.regions : {} };
	} catch {
		return { regions: {} };
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

const entry = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : "";
if (entry === import.meta.url) {
	main().catch((error) => {
		console.error(error.message || error);
		process.exit(1);
	});
}
