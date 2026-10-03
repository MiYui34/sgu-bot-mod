import { deflateSync } from "node:zlib";
import { open, readFile } from "node:fs/promises";
import { decodeNbt, decompressChunk } from "./nbt.js";

const SECTOR = 4096;

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

export async function readChunkNbt(file, index) {
	const handle = await open(file, "r");
	try {
		const header = Buffer.alloc(8192);
		const headerRead = await handle.read(header, 0, 8192, 0);
		if (headerRead.bytesRead < 8192) {
			return null;
		}
		const location = header.readUInt32BE(index * 4);
		if (location === 0) {
			return null;
		}
		const sector = location >> 8;
		const lengthBuf = Buffer.alloc(5);
		await handle.read(lengthBuf, 0, 5, sector * SECTOR);
		const length = lengthBuf.readUInt32BE(0);
		const compression = lengthBuf[4];
		if (length <= 1) {
			return null;
		}
		const payload = Buffer.alloc(length - 1);
		await handle.read(payload, 0, payload.length, sector * SECTOR + 5);
		const nbt = await decompressChunk(compression, payload);
		return decodeNbt(nbt);
	} finally {
		await handle.close();
	}
}

const MAX_CHUNK = 4 * 1024 * 1024;

export async function readRegionChunks(file, indexes) {
	const handle = await open(file, "r");
	try {
		const header = Buffer.alloc(8192);
		const headerRead = await handle.read(header, 0, 8192, 0);
		const found = new Map();
		if (headerRead.bytesRead < 8192) {
			return found;
		}
		for (const index of indexes) {
			const location = header.readUInt32BE(index * 4);
			if (location === 0) {
				found.set(index, null);
				continue;
			}
			const sector = location >> 8;
			const lengthBuf = Buffer.alloc(5);
			await handle.read(lengthBuf, 0, 5, sector * SECTOR);
			const length = lengthBuf.readUInt32BE(0);
			const compression = lengthBuf[4];
			if (length <= 1 || length > MAX_CHUNK) {
				throw new Error(`区块长度异常 ${length}`);
			}
			const payload = Buffer.alloc(length - 1);
			await handle.read(payload, 0, payload.length, sector * SECTOR + 5);
			const nbt = await decompressChunk(compression, payload);
			found.set(index, decodeNbt(nbt));
		}
		return found;
	} finally {
		await handle.close();
	}
}

export async function readChunkNbtFromBuffer(buffer, index) {
	if (buffer.length < 8192) {
		return null;
	}
	const location = buffer.readUInt32BE(index * 4);
	if (location === 0) {
		return null;
	}
	const sector = location >> 8;
	const offset = sector * SECTOR;
	const length = buffer.readUInt32BE(offset);
	const compression = buffer[offset + 4];
	const payload = buffer.subarray(offset + 5, offset + 4 + length);
	return decodeNbt(await decompressChunk(compression, payload));
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
