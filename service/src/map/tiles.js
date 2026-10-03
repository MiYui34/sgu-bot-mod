import { mkdir, open, readdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { PNG } from "pngjs";
import { chunkCoords, parseRegionName, readRegionChunks } from "./anvil.js";
import { chunkToTile, surfaceColors } from "./colors.js";

export const DIMENSIONS = {
	overworld: ["dimensions", "minecraft", "overworld", "region"],
	nether: ["dimensions", "minecraft", "the_nether", "region"],
	end: ["dimensions", "minecraft", "the_end", "region"],
};

const TILE = 256;

export function createMap(options) {
	const worldPath = options.worldPath;
	const cacheDir = options.cacheDir;
	const dirty = new Set();
	const state = { files: {} };
	let revision = 0;
	const changes = [];
	let lastError = "";
	let watchedUntil = 0;

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
	}

	async function tile(dim, tileX, tileZ) {
		if (!DIMENSIONS[dim]) {
			throw new Error("未知维度");
		}
		const filePath = path.join(cacheDir, dim, "0", String(tileX), `${tileZ}.png`);
		const chunks = chunksForTile(tileX, tileZ);
		const needs = chunks.some((chunk) => dirty.has(`${dim}:${chunk.chunkX}:${chunk.chunkZ}`));
		if (!needs) {
			try {
				return await readFile(filePath);
			} catch {
				// 缓存还没有这张图，下面现画。
			}
		}
		return limit(() => paintTile(dim, tileX, tileZ, filePath, chunks));
	}

	async function paintTile(dim, tileX, tileZ, filePath, chunks) {
		const png = new PNG({ width: TILE, height: TILE });
		let painted = false;
		const grouped = new Map();
		for (const chunk of chunks) {
			dirty.delete(`${dim}:${chunk.chunkX}:${chunk.chunkZ}`);
			const regionX = Math.floor(chunk.chunkX / 32);
			const regionZ = Math.floor(chunk.chunkZ / 32);
			const localX = chunk.chunkX - regionX * 32;
			const localZ = chunk.chunkZ - regionZ * 32;
			const file = path.join(worldPath, ...DIMENSIONS[dim], `r.${regionX}.${regionZ}.mca`);
			let group = grouped.get(file);
			if (!group) {
				group = [];
				grouped.set(file, group);
			}
			group.push({ chunk, index: localX + localZ * 32, regionX, regionZ });
		}
		for (const [file, group] of grouped) {
			try {
				await stat(file);
			} catch {
				continue;
			}
			let decoded;
			try {
				decoded = await readRegionChunks(file, group.map((item) => item.index));
			} catch (error) {
				const sample = group[0];
				lastError = `${dim} r.${sample.regionX}.${sample.regionZ}.mca：${error.message}`;
				throw error;
			}
			for (const item of group) {
				const root = decoded.get(item.index);
				if (!root) {
					continue;
				}
				const colors = surfaceColors(root);
				painted = true;
				const place = chunkToTile(item.chunk.chunkX, item.chunk.chunkZ, TILE);
				for (let z = 0; z < 16; z++) {
					for (let x = 0; x < 16; x++) {
						const color = colors[z * 16 + x];
						if (!color) {
							continue;
						}
						const px = place.pixelX + x;
						const py = place.pixelZ + z;
						const i = (png.width * py + px) << 2;
						png.data[i] = color[0];
						png.data[i + 1] = color[1];
						png.data[i + 2] = color[2];
						png.data[i + 3] = color[3];
					}
				}
			}
		}
		const body = PNG.sync.write(png);
		if (painted) {
			await mkdir(path.dirname(filePath), { recursive: true });
			await writeFile(filePath, body);
			noteChange(dim, tileX, tileZ);
		}
		return body;
	}

	return {
		watch,
		watching() {
			return Date.now() < watchedUntil;
		},
		poll,
		tile,
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

let activePaints = 0;
const paintQueue = [];

function limit(task) {
	return new Promise((resolve, reject) => {
		paintQueue.push({ task, resolve, reject });
		pumpPaints();
	});
}

function pumpPaints() {
	if (activePaints >= 1 || paintQueue.length === 0) {
		return;
	}
	activePaints += 1;
	const job = paintQueue.shift();
	job.task().then(job.resolve, job.reject).finally(() => {
		activePaints -= 1;
		pumpPaints();
	});
}
