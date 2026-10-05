import { createWriteStream } from "node:fs";
import { mkdir, readdir, readFile, rename, rm, stat, utimes, writeFile } from "node:fs/promises";
import { availableParallelism, constants, setPriority } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";
import { createBridge } from "../src/bridge.js";
import { loadConfig } from "../src/config.js";
import { MAP_COLOR_EPOCH } from "../src/map/map-palette.js";
import { acquirePreloadLock, preloadLockPath, releasePreloadLock } from "../src/map/preload-lock.js";
import { regionAction } from "../src/map/preload-plan.js";
import { DIMENSIONS } from "../src/map/render.js";
import { partPath, regionPath } from "../src/map/sync.js";
import { createMap, regionTiles } from "../src/map/tiles.js";
import { encodeLosslessWebp } from "../src/map/webp.js";

const NAME = /^r\.-?\d+\.-?\d+\.mca$/;
const DIM_ORDER = ["overworld", "nether", "end"];
const DIM_LABEL = { overworld: "主世界", nether: "下界", end: "末地" };

const force = process.argv.includes("--force");
let stop = false;

async function main() {
	try {
		setPriority(constants.priority.PRIORITY_LOW);
	} catch {
		// 没有权限调整优先级时，仍按原来的方式跑。
	}
	await loadEnv();
	const config = loadConfig();
	const lock = preloadLockPath(config.dataDir);
	await acquirePreloadLock(lock);
	process.on("SIGINT", () => {
		if (stop) {
			process.exit(1);
		}
		stop = true;
		console.log("收到中断，正在画的这批完成后保存进度并退出");
	});
	try {
		await run(config);
	} finally {
		await releasePreloadLock(lock);
	}
}

async function run(config) {
	const bridge = createBridge({ ...config, bridgeUrl: `http://127.0.0.1:${config.httpPort}` });
	const cacheDir = path.join(config.dataDir, "tiles");
	const manifestPath = path.join(config.dataDir, "region-index.json");
	const markerPath = path.join(config.dataDir, "map-world.json");
	const map = createMap({ worldPath: config.worldPath, cacheDir });
	let listed;
	try {
		listed = await bridge.regions();
	} catch (error) {
		if (error.status === 404) {
			throw new Error("模组没有区域同步接口，请先换成带区域列表的 sgu-bridge");
		}
		throw new Error(`连不上模组：${error.message}`);
	}
	const files = (Array.isArray(listed.files) ? listed.files : []).filter((file) => (
		DIMENSIONS[file.dim] && NAME.test(file.name) && Number.isSafeInteger(file.size) && file.size >= 8192
	));
	if (files.length === 0) {
		throw new Error("模组没有返回任何区域文件，已停止，避免把现有地图清掉");
	}
	files.sort((a, b) => {
		const order = DIM_ORDER.indexOf(a.dim) - DIM_ORDER.indexOf(b.dim);
		if (order !== 0) {
			return order;
		}
		return a.name.localeCompare(b.name, "en");
	});
	const world = typeof listed.world === "string" ? listed.world : "";
	const marker = await readMarker(markerPath);
	let manifest = await readManifest(manifestPath);
	if (world && marker.world && world !== marker.world) {
		console.log("世界已更换，清掉旧图后重画");
		await map.resetCache();
		manifest = { files: {} };
	}
	await writeMarker(markerPath, { world: world || marker.world || "", epoch: 2 });
	const remote = new Set(files.map((file) => `${file.dim}/${file.name}`));
	await prune(config.worldPath, manifest, remote, map);
	await writeManifest(manifestPath, manifest);
	await writeColorEpoch(cacheDir);

	const blank = await encodeLosslessWebp(new Uint8ClampedArray(256 * 256 * 4), 256, 256);
	const jobs = jobCount();
	process.env.UV_THREADPOOL_SIZE = String(Math.max(8, jobs * 2));
	const pool = createRenderPool(jobs);
	let painted = 0;
	let skipped = 0;
	let dropped = 0;
	let failed = 0;
	let released = 0;
	let paintMs = 0;
	const failures = [];
	let manifestWriting = Promise.resolve();
	console.log(`开始全量加载 ${files.length} 个区域，同时处理 ${jobs} 个${force ? "（强制重画）" : ""}`);

	async function processFile(file, index) {
		const key = `${file.dim}/${file.name}`;
		const dest = regionPath(config.worldPath, file.dim, file.name);
		const tiles = regionTiles(file.dim, file.name);
		const ready = await tilesExist(cacheDir, file.dim, tiles);
		const local = await stat(dest).catch(() => null);
		const action = regionAction({
			entry: manifest.files[key],
			file,
			tilesReady: ready,
			epoch: MAP_COLOR_EPOCH,
			force,
			localExists: Boolean(local),
		});
		const label = `${index + 1}/${files.length} ${DIM_LABEL[file.dim] || file.dim} ${file.name}`;
		if (action === "skip") {
			skipped += 1;
			if (skipped % 200 === 0) {
				console.log(`${label} 已跳过 ${skipped} 个画好的区域`);
			}
			return;
		}
		if (action === "drop") {
			released += await removeFile(dest);
			dropped += 1;
			console.log(`${label} 瓦片已是新颜色，删除区域副本 ${formatBytes(local.size)}`);
			return;
		}
		const began = Date.now();
		try {
			const downloaded = await ensureLocal(bridge, file, dest);
			if (!downloaded) {
				throw new Error("下载失败");
			}
			const info = await stat(dest);
			if (info.size <= 8192) {
				await Promise.all(tiles.map((tile) => storeTile(tileFile(cacheDir, file.dim, tile), blank)));
			} else {
				const rendered = await pool.render({ worldPath: config.worldPath, dim: file.dim, name: file.name });
				await Promise.all(rendered.bodies.map((tile) => storeTile(
					tileFile(cacheDir, file.dim, tile),
					tile.body ? Buffer.from(tile.body) : blank,
				)));
			}
			released += info.size;
			await rm(dest, { force: true });
			manifest.files[key] = { size: file.size, mtime: Number(file.mtime), color: MAP_COLOR_EPOCH };
			painted += 1;
			paintMs += Date.now() - began;
			const done = painted + skipped + dropped + failed;
			const remain = Math.round((paintMs / painted) * (files.length - done) / 1000);
			console.log(`${label} 已画好，释放 ${formatBytes(info.size)}，大约还要 ${remain}s`);
		} catch (error) {
			failed += 1;
			failures.push(key);
			manifest.files[key] = { size: file.size, mtime: Number(file.mtime), pending: true };
			console.log(`${label} 失败：${error.message}`);
		}
		manifestWriting = manifestWriting.then(() => writeManifest(manifestPath, manifest)).catch((error) => {
			console.error(`区域索引保存失败：${error.message}`);
		});
	}

	try {
		let next = 0;
		let running = 0;
		await new Promise((resolve) => {
			const kick = () => {
				if (running === 0 && (stop || next >= files.length)) {
					resolve();
					return;
				}
				while (!stop && running < jobs && next < files.length) {
					const index = next;
					next += 1;
					running += 1;
					processFile(files[index], index).finally(() => {
						running -= 1;
						kick();
					});
				}
			};
			kick();
		});
		await manifestWriting;
	} finally {
		await pool.close();
	}
	await writeManifest(manifestPath, manifest);
	await writeColorEpoch(cacheDir);
	console.log(`全量结束：绘制 ${painted}，跳过 ${skipped}，只删副本 ${dropped}，失败 ${failed}，释放 ${formatBytes(released)}`);
	if (failures.length > 0) {
		console.log(`失败的区域：${failures.slice(0, 20).join("，")}`);
		process.exitCode = 1;
	}
	if (stop) {
		console.log("已中断，再次运行会从还没画完的区域继续");
		process.exitCode = 1;
	}
}

function jobCount() {
	const fromArg = process.argv.find((item) => item.startsWith("--jobs="));
	if (fromArg) {
		const value = Number(fromArg.slice("--jobs=".length));
		if (Number.isInteger(value) && value >= 1 && value <= 8) {
			return value;
		}
	}
	return Math.min(4, Math.max(2, availableParallelism() - 1));
}

function tileFile(cacheDir, dim, tile) {
	return path.join(cacheDir, dim, "0", String(tile.tileX), `${tile.tileZ}.webp`);
}

function createRenderPool(size) {
	const workers = [];
	const waiters = [];
	let nextId = 1;
	let closed = false;

	function pump() {
		for (const worker of workers) {
			if (closed || !worker.idle || waiters.length === 0) {
				continue;
			}
			const waiter = waiters.shift();
			worker.idle = false;
			worker.current = waiter;
			worker.postMessage(waiter.message);
		}
	}

	function spawn() {
		const worker = new Worker(new URL("./preload-worker.js", import.meta.url));
		worker.idle = true;
		worker.current = null;
		worker.retired = false;
		worker.on("message", (message) => {
			const current = worker.current;
			worker.current = null;
			worker.idle = true;
			if (message.error) {
				current?.reject(new Error(message.error));
			} else {
				current?.resolve(message);
			}
			pump();
		});
		worker.on("error", (error) => {
			if (worker.retired) {
				return;
			}
			worker.retired = true;
			worker.current?.reject(error);
			worker.current = null;
			replace(worker);
		});
		worker.on("exit", (code) => {
			if (worker.retired || closed) {
				return;
			}
			worker.retired = true;
			worker.current?.reject(new Error(`绘制进程退出 ${code}`));
			worker.current = null;
			replace(worker);
		});
		return worker;
	}

	function replace(worker) {
		if (closed) {
			return;
		}
		const index = workers.indexOf(worker);
		if (index >= 0) {
			workers.splice(index, 1, spawn());
		}
		pump();
	}

	for (let index = 0; index < size; index++) {
		workers.push(spawn());
	}

	return {
		render(message) {
			return new Promise((resolve, reject) => {
				waiters.push({ resolve, reject, message: { ...message, id: nextId } });
				nextId += 1;
				pump();
			});
		},
		async close() {
			closed = true;
			for (const waiter of waiters.splice(0)) {
				waiter.reject(new Error("绘制已停止"));
			}
			await Promise.all(workers.map((worker) => {
				worker.retired = true;
				return worker.terminate();
			}));
		},
	};
}

async function tilesExist(cacheDir, dim, tiles) {
	if (tiles.length !== 4) {
		return false;
	}
	for (const tile of tiles) {
		try {
			await stat(path.join(cacheDir, dim, "0", String(tile.tileX), `${tile.tileZ}.webp`));
		} catch {
			return false;
		}
	}
	return true;
}

async function ensureLocal(bridge, file, dest) {
	const local = await stat(dest).catch(() => null);
	if (local && local.size === file.size && Math.abs(local.mtimeMs - Number(file.mtime)) < 2000) {
		return true;
	}
	return download(bridge, file, dest);
}

async function download(bridge, file, dest) {
	await mkdir(path.dirname(dest), { recursive: true });
	const temporary = partPath(dest);
	try {
		const response = await bridge.openRegion(file.dim, file.name);
		await pipeline(Readable.fromWeb(response.body), createWriteStream(temporary));
		const written = await stat(temporary);
		if (written.size !== file.size) {
			await rm(temporary, { force: true });
			return false;
		}
		await replaceFile(temporary, dest);
		const when = new Date(Number(file.mtime));
		await utimes(dest, when, when);
		return true;
	} catch (error) {
		await rm(temporary, { force: true });
		console.error(`区域文件 ${file.dim}/${file.name} 同步失败：${error.message}`);
		return false;
	}
}

async function prune(worldPath, manifest, remote, map) {
	for (const key of Object.keys(manifest.files)) {
		if (remote.has(key)) {
			continue;
		}
		const split = key.indexOf("/");
		const dim = key.slice(0, split);
		const name = key.slice(split + 1);
		await map.forgetRegion(dim, name);
		const dest = regionPath(worldPath, dim, name);
		if (dest) {
			await rm(dest, { force: true });
		}
		delete manifest.files[key];
		console.log(`移除已不在服务器上的 ${dim}/${name}`);
	}
	for (const dim of Object.keys(DIMENSIONS)) {
		let names = [];
		try {
			names = await readdir(path.join(worldPath, ...DIMENSIONS[dim]));
		} catch {
			continue;
		}
		for (const name of names) {
			if (!NAME.test(name) || remote.has(`${dim}/${name}`)) {
				continue;
			}
			await rm(path.join(worldPath, ...DIMENSIONS[dim], name), { force: true });
			await map.forgetRegion(dim, name);
			console.log(`移除已不在服务器上的 ${dim}/${name}`);
		}
	}
}

async function writeColorEpoch(cacheDir) {
	await mkdir(cacheDir, { recursive: true });
	await writeFile(path.join(cacheDir, ".color-epoch"), JSON.stringify({ epoch: MAP_COLOR_EPOCH, since: 0 }));
}

async function storeTile(filePath, body) {
	await mkdir(path.dirname(filePath), { recursive: true });
	const temporary = `${filePath}.${process.pid}.tmp`;
	await writeFile(temporary, body);
	await replaceFile(temporary, filePath);
}

async function removeFile(file) {
	const info = await stat(file).catch(() => null);
	if (!info) {
		return 0;
	}
	await rm(file, { force: true });
	return info.size;
}

async function replaceFile(temporary, dest) {
	try {
		await rename(temporary, dest);
	} catch (error) {
		if (error.code !== "EPERM" && error.code !== "EEXIST") {
			throw error;
		}
		await rm(dest, { force: true });
		await rename(temporary, dest);
	}
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
	await replaceFile(temporary, file);
}

async function readMarker(file) {
	try {
		const parsed = JSON.parse(await readFile(file, "utf8"));
		return { world: typeof parsed.world === "string" ? parsed.world : "" };
	} catch {
		return { world: "" };
	}
}

async function writeMarker(file, marker) {
	await mkdir(path.dirname(file), { recursive: true });
	const temporary = `${file}.${process.pid}.tmp`;
	await writeFile(temporary, JSON.stringify(marker));
	await replaceFile(temporary, file);
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

function startedDirectly() {
	const entry = process.argv[1];
	if (!entry) {
		return false;
	}
	return import.meta.url === pathToFileURL(path.resolve(entry)).href;
}

if (startedDirectly()) {
	main().catch((error) => {
		console.error(error.message || error);
		process.exitCode = 1;
	});
}
