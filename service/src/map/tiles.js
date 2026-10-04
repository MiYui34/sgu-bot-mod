import { mkdir, open, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { chunkCoords, parseRegionName } from "./anvil.js";
import { encodeLosslessWebp } from "./webp.js";
import { renderInPool } from "./pool.js";
import { DIMENSIONS } from "./render.js";

export { DIMENSIONS };

const TILE = 256;

export function createMap(options) {
	const worldPath = options.worldPath;
	const cacheDir = options.cacheDir;
	const dirty = new Set();
	const emptyTiles = new Set();
	const inflight = new Map();
	const state = { files: {} };
	let revision = 0;
	const changes = [];
	let lastError = "";
	let watchedUntil = 0;
	let regionGeneration = 0;

	function noteChange(dim, tileX, tileZ) {
		revision += 1;
		changes.push({ revision, tile: `${dim}/0/${tileX}/${tileZ}` });
		if (changes.length > 400) {
			changes.shift();
		}
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
		const chunks = chunksForTile(tileX, tileZ);
		const needs = chunks.some((chunk) => dirty.has(`${dim}:${chunk.chunkX}:${chunk.chunkZ}`));
		if (!needs) {
			if (emptyTiles.has(key)) {
				return blankTile();
			}
			try {
				return await readFile(filePath);
			} catch {
				// 缓存还没有这张图，下面安排绘制。
			}
		}
		if (!inflight.has(key)) {
			const job = paintTile(dim, tileX, tileZ, filePath, chunks)
				.catch((error) => {
					lastError = error.message;
				})
				.finally(() => inflight.delete(key));
			inflight.set(key, job);
		}
		try {
			return await readFile(filePath);
		} catch {
			return blankTile();
		}
	}

	function notifyRegionFile(dim, name) {
		const match = /^r\.(-?\d+)\.(-?\d+)\.mca$/.exec(name);
		if (!match || !DIMENSIONS[dim]) {
			return;
		}
		regionGeneration += 1;
		for (const key of regionTileKeys(dim, Number(match[1]), Number(match[2]))) {
			emptyTiles.delete(key);
			const [, tileX, tileZ] = key.split("/");
			noteChange(dim, Number(tileX), Number(tileZ));
		}
	}

	async function paintTile(dim, tileX, tileZ, filePath, chunks) {
		const generation = regionGeneration;
		for (const chunk of chunks) {
			dirty.delete(`${dim}:${chunk.chunkX}:${chunk.chunkZ}`);
		}
		const rendered = await renderInPool({ worldPath, dim, chunks });
		if (!rendered.painted || !rendered.body) {
			if (generation === regionGeneration) {
				emptyTiles.add(`${dim}/${tileX}/${tileZ}`);
			}
			return blankTile();
		}
		const body = Buffer.isBuffer(rendered.body) ? rendered.body : Buffer.from(rendered.body);
		emptyTiles.delete(`${dim}/${tileX}/${tileZ}`);
		await mkdir(path.dirname(filePath), { recursive: true });
		const temporary = `${filePath}.${process.pid}.tmp`;
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
		noteChange(dim, tileX, tileZ);
		return body;
	}

	return {
		watch,
		watching() {
			return Date.now() < watchedUntil;
		},
		poll,
		tile,
		notifyRegionFile,
		status() {
			return {
				worldPath,
				lastError,
				dirty: dirty.size,
				revision,
			};
		},
		changesSince(since) {
			return {
				revision,
				tiles: changes.filter((item) => item.revision > since).map((item) => item.tile),
			};
		},
	};
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
