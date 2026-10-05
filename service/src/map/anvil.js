import { deflateSync } from "node:zlib";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { decompressChunk, readMapChunk } from "./nbt.js";

const SECTOR = 4096;
const MAX_EXTERNAL = 64 * 1024 * 1024;

export function chunkIndex(localX, localZ) {
	return (localX & 31) + (localZ & 31) * 32;
}

export function chunkCoords(regionX, regionZ, index) {
	return {
		chunkX: regionX * 32 + (index & 31),
		chunkZ: regionZ * 32 + (index >> 5),
	};
}

export function parseRegionName(fileName) {
	const match = /^r\.(-?\d+)\.(-?\d+)\.mca$/.exec(fileName);
	if (!match) {
		return null;
	}
	return { regionX: Number(match[1]), regionZ: Number(match[2]) };
}

export function readTimestamps(buffer) {
	const stamps = new Map();
	if (buffer.length < 8192) {
		return stamps;
	}
	for (let index = 0; index < 1024; index++) {
		const location = buffer.readUInt32BE(index * 4);
		if (location === 0) {
			continue;
		}
		stamps.set(index, buffer.readInt32BE(4096 + index * 4));
	}
	return stamps;
}

const MAX_CHUNK = 4 * 1024 * 1024;
const regionCache = new Map();
const regionLoads = new Map();

export async function readChunkNbt(file, index, minY = -64) {
	return chunkFromRegion(await regionBuffer(file), index, minY);
}

// 单个区块坏了只空出这一格，不连累同一张图里的其它区块。
export async function readRegionChunks(file, indexes, minY = -64, onError = null) {
	const buffer = await regionBuffer(file);
	const found = new Map();
	const jobs = [];
	for (const index of indexes) {
		let located = null;
		try {
			located = locateChunk(buffer, index);
		} catch (error) {
			onError?.(index, error);
		}
		if (!located) {
			found.set(index, null);
			continue;
		}
		jobs.push({ index, ...located });
	}
	for (let start = 0; start < jobs.length; start += 4) {
		const batch = jobs.slice(start, start + 4);
		const decoded = await Promise.all(batch.map(async (job) => {
			try {
				return readMapChunk(await chunkBytes(file, job), minY);
			} catch (error) {
				onError?.(job.index, error);
				return null;
			}
		}));
		for (let index = 0; index < batch.length; index++) {
			found.set(batch[index].index, decoded[index]);
		}
	}
	return found;
}

// 压缩类型最高位表示区块太大，正文放在同目录的 c.<x>.<z>.mcc 里。
async function chunkBytes(file, job) {
	if ((job.compression & 0x80) === 0) {
		return decompressChunk(job.compression, job.payload);
	}
	const region = parseRegionName(path.basename(file));
	if (!region) {
		throw new Error("区域文件名不对，找不到外置区块");
	}
	const coords = chunkCoords(region.regionX, region.regionZ, job.index);
	const external = path.join(path.dirname(file), `c.${coords.chunkX}.${coords.chunkZ}.mcc`);
	const body = await readFile(external);
	if (body.length > MAX_EXTERNAL) {
		throw new Error(`外置区块太大 ${body.length}`);
	}
	return decompressChunk(job.compression & 0x7f, body);
}

export async function readChunkNbtFromBuffer(buffer, index, minY = -64) {
	return chunkFromRegion(buffer, index, minY);
}

async function chunkFromRegion(buffer, index, minY) {
	const located = locateChunk(buffer, index);
	if (!located) {
		return null;
	}
	if ((located.compression & 0x80) !== 0) {
		throw new Error("区块在外置 .mcc 文件里");
	}
	return readMapChunk(await decompressChunk(located.compression, located.payload), minY);
}

function locateChunk(buffer, index) {
	if (!buffer || buffer.length < 8192 || index < 0 || index > 1023) {
		return null;
	}
	const location = buffer.readUInt32BE(index * 4);
	if (location === 0) {
		return null;
	}
	const offset = (location >>> 8) * SECTOR;
	if (offset + 5 > buffer.length) {
		throw new Error("区块超出区域文件");
	}
	const length = buffer.readUInt32BE(offset);
	const compression = buffer[offset + 4];
	if ((compression & 0x80) !== 0 && length >= 1 && length <= MAX_CHUNK && offset + 4 + length <= buffer.length) {
		return { compression, payload: buffer.subarray(offset + 5, offset + 4 + length) };
	}
	if (length <= 1 || length > MAX_CHUNK) {
		throw new Error(`区块长度异常 ${length}`);
	}
	const end = offset + 4 + length;
	if (end > buffer.length) {
		throw new Error("区块超出区域文件");
	}
	return { compression, payload: buffer.subarray(offset + 5, end) };
}

async function regionBuffer(file) {
	const pending = regionLoads.get(file);
	if (pending) {
		return pending;
	}
	const job = loadRegion(file).finally(() => regionLoads.delete(file));
	regionLoads.set(file, job);
	return job;
}

async function loadRegion(file) {
	const info = await stat(file);
	const cached = regionCache.get(file);
	if (cached && cached.mtime === info.mtimeMs && cached.size === info.size) {
		cached.used = Date.now();
		return cached.buffer;
	}
	const buffer = await readFile(file);
	regionCache.set(file, { mtime: info.mtimeMs, size: info.size, buffer, used: Date.now() });
	while (regionCache.size > 6) {
		let oldestKey = null;
		let oldestUsed = Infinity;
		for (const [key, value] of regionCache) {
			if (value.used < oldestUsed) {
				oldestUsed = value.used;
				oldestKey = key;
			}
		}
		regionCache.delete(oldestKey);
	}
	return buffer;
}

export function writeTestRegion(chunks) {
	const header = Buffer.alloc(8192);
	const bodies = [];
	let nextSector = 2;
	for (const chunk of chunks) {
		const payload = deflateSync(chunk.nbt);
		const length = payload.length + 1;
		const sectorCount = Math.ceil((4 + length) / SECTOR);
		const index = chunkIndex(chunk.localX, chunk.localZ);
		header.writeUInt32BE((nextSector << 8) | sectorCount, index * 4);
		header.writeInt32BE(chunk.timestamp ?? 1, 4096 + index * 4);
		const body = Buffer.alloc(sectorCount * SECTOR);
		body.writeUInt32BE(length, 0);
		body.writeUInt8(2, 4);
		payload.copy(body, 5);
		bodies.push(body);
		nextSector += sectorCount;
	}
	return Buffer.concat([header, ...bodies]);
}

export async function readRegionFile(file) {
	return readFile(file);
}
