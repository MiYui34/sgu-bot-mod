import { randomBytes } from "node:crypto";
import { mkdir, open, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { chunkCoords, parseRegionName } from "./anvil.js";
import { chunkToTile } from "./colors.js";
import { preloadActive } from "./preload-lock.js";
import { encodeLosslessWebp } from "./webp.js";
import { renderInPool } from "./pool.js";
import { DIMENSIONS } from "./render.js";

export { DIMENSIONS };

const TILE = 256;
// 网页每 400ms 拉一次变更；只留最近这么多条，落后更多的网页直接整张重载。
const CHANGE_LIMIT = 8192;

export function createMap(options) {
	const worldPath = options.worldPath;
	const cacheDir = options.cacheDir;
	const dirty = new Set();
	const emptyTiles = new Set();
	const inflight = new Map();
	const state = { files: {} };
	let revision = 0;
	let resetStamp = 0;
	let changeFloor = 0;
	const boot = randomBytes(6).toString("hex");
	const changed = new Map();
	const askedAt = new Map();
	let lastError = "";
	let watchedUntil = 0;
	let regionGeneration = 0;

	function noteChange(dim, tileX, tileZ) {
		revision += 1;
		const key = `${dim}/0/${tileX}/${tileZ}`;
		changed.delete(key);
		changed.set(key, revision);
		while (changed.size > CHANGE_LIMIT) {
			const [oldest, rev] = changed.entries().next().value;
			changed.delete(oldest);
			changeFloor = Math.max(changeFloor, rev);
		}
	}

	function pendingTile() {
		const error = new Error("瓦片还在画");
		error.code = "TILE_PENDING";
		return error;
	}

	function watch() {
		watchedUntil = Date.now() + 60_000;
	}

	async function poll() {
		const updatedTiles = new Set();
		for (const dim of Object.keys(DIMENSIONS)) {
			const dir = path.join(worldPath, ...DIMENSIONS[dim]);
			let names = [];
			try {
				names = (await readdir(dir)).filter((name) => name.endsWith(".mca"));
			} catch {
				continue;
			}
			const seen = new Set();
			for (const name of names) {
				const region = parseRegionName(name);
				if (!region) {
					continue;
				}
				const file = path.join(dir, name);
				let mtime = 0;
				try {
					mtime = (await stat(file)).mtimeMs;
				} catch {
					continue;
				}
				const key = `${dim}/${name}`;
				seen.add(key);
				const previous = state.files[key];
				if (previous && previous.mtime === mtime) {
					continue;
				}
				let stamps;
				try {
					const header = Buffer.alloc(8192);
					const handle = await open(file, "r");
					try {
						const read = await handle.read(header, 0, 8192, 0);
						if (read.bytesRead < 8192) {
							continue;
						}
						stamps = Buffer.from(header.subarray(4096, 8192));
					} finally {
						await handle.close();
					}
				} catch (error) {
					lastError = error.message;
					continue;
				}
				if (previous) {
					for (let index = 0; index < 1024; index++) {
						if (previous.stamps.readInt32BE(index * 4) === stamps.readInt32BE(index * 4)) {
							continue;
						}
						const coords = chunkCoords(region.regionX, region.regionZ, index);
						dirty.add(`${dim}:${coords.chunkX}:${coords.chunkZ}`);
						const place = chunkToTile(coords.chunkX, coords.chunkZ, TILE);
						updatedTiles.add(`${dim}/${place.tileX}/${place.tileZ}`);
					}
				}
				for (const tileKey of regionTileKeys(dim, region.regionX, region.regionZ)) {
					if (emptyTiles.delete(tileKey)) {
						updatedTiles.add(tileKey);
					}
				}
				state.files[key] = { mtime, stamps };
			}
			for (const key of Object.keys(state.files)) {
				if (key.startsWith(`${dim}/`) && !seen.has(key)) {
					delete state.files[key];
				}
			}
		}
		for (const key of updatedTiles) {
			const [dim, tileX, tileZ] = key.split("/");
			noteChange(dim, Number(tileX), Number(tileZ));
		}
	}

	async function tile(dim, tileX, tileZ) {
		if (!DIMENSIONS[dim]) {
			throw new Error("未知维度");
		}
		const key = `${dim}/${tileX}/${tileZ}`;
		const filePath = path.join(cacheDir, dim, "0", String(tileX), `${tileZ}.webp`);
		if (options.preloadLock && await preloadActive(options.preloadLock)) {
			try {
				return await readFile(filePath);
			} catch {
				throw pendingTile();
			}
		}
		const chunks = chunksForTile(tileX, tileZ);
		const needs = chunks.some((chunk) => dirty.has(`${dim}:${chunk.chunkX}:${chunk.chunkZ}`));
		if (options.preferRemote?.()) {
			let body = null;
			try {
				body = await readFile(filePath);
			} catch {
				body = null;
			}
			if (!body || needs) {
				askRemote(dim, tileX, tileZ);
			}
			if (body) {
				return body;
			}
			throw pendingTile();
		}
		if (!needs) {
			if (emptyTiles.has(key)) {
				try {
					return await readFile(filePath);
				} catch {
					return blankTile();
				}
			}
			try {
				return await readFile(filePath);
			} catch {
				// 缓存还没有这张图，下面安排绘制。
			}
		}
		schedulePaint(dim, tileX, tileZ, filePath, chunks);
		try {
			return await readFile(filePath);
		} catch {
			throw pendingTile();
		}
	}

	function schedulePaint(dim, tileX, tileZ, filePath, chunks) {
		const key = `${dim}/${tileX}/${tileZ}`;
		if (inflight.has(key)) {
			return;
		}
		const job = paintTile(dim, tileX, tileZ, filePath, chunks)
			.catch((error) => {
				lastError = error.message;
				return null;
			})
			.finally(() => inflight.delete(key));
		inflight.set(key, job);
	}

	async function acceptUpload(dim, tileX, tileZ, body) {
		if (!DIMENSIONS[dim] || !Number.isInteger(tileX) || !Number.isInteger(tileZ)) {
			return;
		}
		if (Math.abs(tileX) > 1_000_000 || Math.abs(tileZ) > 1_000_000) {
			return;
		}
		const filePath = tilePath(cacheDir, dim, tileX, tileZ);
		await storeTile(filePath, body);
		const key = `${dim}/${tileX}/${tileZ}`;
		emptyTiles.delete(key);
		askedAt.delete(key);
		for (const chunk of chunksForTile(tileX, tileZ)) {
			dirty.delete(`${dim}:${chunk.chunkX}:${chunk.chunkZ}`);
		}
		noteChange(dim, tileX, tileZ);
	}

	function askRemote(dim, tileX, tileZ) {
		if (typeof options.requestTile !== "function") {
			return;
		}
		const key = `${dim}/${tileX}/${tileZ}`;
		const now = Date.now();
		if (now - (askedAt.get(key) || 0) < 3000) {
			return;
		}
		askedAt.set(key, now);
		options.requestTile(dim, tileX, tileZ);
	}

	async function notifyRegionFile(dim, name) {
		const region = parseRegionName(name);
		if (!region || !DIMENSIONS[dim]) {
			return;
		}
		regionGeneration += 1;
		for (let index = 0; index < 1024; index++) {
			const coords = chunkCoords(region.regionX, region.regionZ, index);
			dirty.add(`${dim}:${coords.chunkX}:${coords.chunkZ}`);
		}
		for (const key of regionTileKeys(dim, region.regionX, region.regionZ)) {
			emptyTiles.delete(key);
			const [, tileX, tileZ] = key.split("/");
			noteChange(dim, Number(tileX), Number(tileZ));
		}
	}

	async function forgetRegion(dim, name) {
		const region = parseRegionName(name);
		if (!region || !DIMENSIONS[dim]) {
			return;
		}
		regionGeneration += 1;
		delete state.files[`${dim}/${name}`];
		for (let index = 0; index < 1024; index++) {
			const coords = chunkCoords(region.regionX, region.regionZ, index);
			dirty.delete(`${dim}:${coords.chunkX}:${coords.chunkZ}`);
		}
		for (const key of regionTileKeys(dim, region.regionX, region.regionZ)) {
			const [, tileX, tileZ] = key.split("/");
			await rm(tilePath(cacheDir, dim, tileX, tileZ), { force: true });
			emptyTiles.add(key);
			noteChange(dim, Number(tileX), Number(tileZ));
		}
	}

	async function paintRegion(dim, name) {
		const region = parseRegionName(name);
		if (!region || !DIMENSIONS[dim]) {
			return;
		}
		await notifyRegionFile(dim, name);
		for (const key of regionTileKeys(dim, region.regionX, region.regionZ)) {
			const [, tileX, tileZ] = key.split("/");
			await tile(dim, Number(tileX), Number(tileZ));
		}
	}

	async function resetCache() {
		regionGeneration += 1;
		dirty.clear();
		emptyTiles.clear();
		state.files = {};
		changed.clear();
		revision += 1;
		resetStamp = revision;
		await rm(cacheDir, { recursive: true, force: true });
	}

	async function paintTile(dim, tileX, tileZ, filePath, chunks) {
		const generation = regionGeneration;
		for (const chunk of chunks) {
			dirty.delete(`${dim}:${chunk.chunkX}:${chunk.chunkZ}`);
		}
		if (typeof options.ensureRegion === "function") {
			const states = await Promise.all(regionFileNames(chunks).map((name) => options.ensureRegion(dim, name)));
			if (generation !== regionGeneration) {
				return null;
			}
			if (states.includes("failed")) {
				// 区域没拉下来，旧图不能当成已经画过，下次打开再试。
				for (const chunk of chunks) {
					dirty.add(`${dim}:${chunk.chunkX}:${chunk.chunkZ}`);
				}
				return null;
			}
		}
		const rendered = await renderInPool({ worldPath, dim, chunks });
		if (generation !== regionGeneration) {
			return null;
		}
		if (rendered.missing) {
			emptyTiles.add(`${dim}/${tileX}/${tileZ}`);
			return readFile(filePath).catch(() => blankTile());
		}
		if (!rendered.painted || !rendered.body) {
			try {
				return await readFile(filePath);
			} catch {
				// 这块本来就没有图，下面写一张空白。
			}
			if (generation === regionGeneration) {
				emptyTiles.add(`${dim}/${tileX}/${tileZ}`);
			}
			const blank = await blankTile();
			await storeTile(filePath, blank);
			await release(dim, tileX, tileZ);
			return blank;
		}
		const body = Buffer.isBuffer(rendered.body) ? rendered.body : Buffer.from(rendered.body);
		emptyTiles.delete(`${dim}/${tileX}/${tileZ}`);
		await storeTile(filePath, body);
		noteChange(dim, tileX, tileZ);
		await release(dim, tileX, tileZ);
		return body;
	}

	async function release(dim, tileX, tileZ) {
		if (!options.releaseRegion) {
			return;
		}
		try {
			await options.releaseRegion(dim, tileX, tileZ);
		} catch (error) {
			lastError = error.message;
		}
	}

	function regionSettled(dim, name) {
		const region = parseRegionName(name);
		if (!region || !DIMENSIONS[dim]) {
			return false;
		}
		for (let index = 0; index < 1024; index++) {
			const coords = chunkCoords(region.regionX, region.regionZ, index);
			if (dirty.has(`${dim}:${coords.chunkX}:${coords.chunkZ}`)) {
				return false;
			}
		}
		return true;
	}

	async function regionCached(dim, name) {
		const region = parseRegionName(name);
		if (!region || !DIMENSIONS[dim]) {
			return false;
		}
		for (const key of regionTileKeys(dim, region.regionX, region.regionZ)) {
			const [, tileX, tileZ] = key.split("/");
			try {
				await stat(tilePath(cacheDir, dim, tileX, tileZ));
			} catch {
				return false;
			}
		}
		return true;
	}

	return {
		watch,
		watching() {
			return Date.now() < watchedUntil;
		},
		poll,
		tile,
		acceptUpload,
		notifyRegionFile,
		forgetRegion,
		paintRegion,
		regionCached,
		regionSettled,
		resetCache,
		status() {
			return {
				worldPath,
				lastError,
				dirty: dirty.size,
				revision,
			};
		},
		changesSince(since) {
			const from = Number.isFinite(since) ? since : 0;
			// 刚打开的网页画的已经是当前的图；版本比服务端还新说明服务重启过，得整张重载。
			if (from <= 0) {
				return { boot, revision, reset: false, tiles: [] };
			}
			if (from > revision || from < resetStamp || from < changeFloor) {
				return { boot, revision, reset: true, tiles: [] };
			}
			const tiles = [];
			for (const [tile, rev] of changed) {
				if (rev > from) {
					tiles.push(tile);
				}
			}
			return { boot, revision, reset: false, tiles };
		},
	};
}

let tempSerial = 0;

// 同一张图可能同时被模组上传和本地绘制写入，临时文件名必须各不相同。
async function storeTile(filePath, body) {
	await mkdir(path.dirname(filePath), { recursive: true });
	tempSerial += 1;
	const temporary = `${filePath}.${process.pid}.${tempSerial}.tmp`;
	try {
		await writeFile(temporary, body);
		try {
			await rename(temporary, filePath);
		} catch (error) {
			if (error.code !== "EPERM" && error.code !== "EEXIST") {
				throw error;
			}
			await rm(filePath, { force: true });
			await rename(temporary, filePath);
		}
	} catch (error) {
		await rm(temporary, { force: true });
		throw error;
	}
}

function tilePath(cacheDir, dim, tileX, tileZ) {
	return path.join(cacheDir, dim, "0", String(tileX), `${tileZ}.webp`);
}

function regionTileKeys(dim, regionX, regionZ) {
	const chunksPerTile = TILE / 16;
	const tileX0 = Math.floor((regionX * 32) / chunksPerTile);
	const tileZ0 = Math.floor((regionZ * 32) / chunksPerTile);
	const span = 32 / chunksPerTile;
	const keys = [];
	for (let dz = 0; dz < span; dz++) {
		for (let dx = 0; dx < span; dx++) {
			keys.push(`${dim}/${tileX0 + dx}/${tileZ0 + dz}`);
		}
	}
	return keys;
}

export function regionTiles(dim, name) {
	const region = parseRegionName(name);
	if (!region || !DIMENSIONS[dim]) {
		return [];
	}
	return regionTileKeys(dim, region.regionX, region.regionZ).map((key) => {
		const [, tileX, tileZ] = key.split("/");
		const x = Number(tileX);
		const z = Number(tileZ);
		return { tileX: x, tileZ: z, chunks: chunksForTile(x, z) };
	});
}

function regionFileNames(chunks) {
	const names = new Set();
	for (const chunk of chunks) {
		const regionX = Math.floor(chunk.chunkX / 32);
		const regionZ = Math.floor(chunk.chunkZ / 32);
		names.add(`r.${regionX}.${regionZ}.mca`);
	}
	return [...names];
}

function chunksForTile(tileX, tileZ) {
	const chunks = [];
	const chunkX0 = tileX * (TILE / 16);
	const chunkZ0 = tileZ * (TILE / 16);
	for (let dz = 0; dz < TILE / 16; dz++) {
		for (let dx = 0; dx < TILE / 16; dx++) {
			chunks.push({ chunkX: chunkX0 + dx, chunkZ: chunkZ0 + dz });
		}
	}
	return chunks;
}

let blankPromise;

function blankTile() {
	if (!blankPromise) {
		blankPromise = encodeLosslessWebp(new Uint8ClampedArray(TILE * TILE * 4), TILE, TILE).catch((error) => {
			blankPromise = null;
			throw error;
		});
	}
	return blankPromise;
}
