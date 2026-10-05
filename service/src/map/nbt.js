import { promisify } from "node:util";
import { gunzip, inflate } from "node:zlib";

const gunzipAsync = promisify(gunzip);
const inflateAsync = promisify(inflate);

const END = 0;
const BYTE = 1;
const SHORT = 2;
const INT = 3;
const LONG = 4;
const FLOAT = 5;
const DOUBLE = 6;
const BYTE_ARRAY = 7;
const STRING = 8;
const LIST = 9;
const COMPOUND = 10;
const INT_ARRAY = 11;
const LONG_ARRAY = 12;

export function decodeNbt(buffer) {
	const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
	let offset = 0;
	const read = (size) => {
		const value = offset;
		offset += size;
		if (offset > buffer.length) {
			throw new Error("NBT 超出文件末尾");
		}
		return value;
	};
	const type = buffer[read(1)];
	if (type !== COMPOUND) {
		throw new Error(`区块根标签不是 compound（${type}）`);
	}
	readString();
	return readPayload(type);

	function readString() {
		const length = view.getUint16(read(2));
		const start = read(length);
		return buffer.toString("utf8", start, start + length);
	}

	function readPayload(tag) {
		switch (tag) {
			case END:
				return null;
			case BYTE:
				return view.getInt8(read(1));
			case SHORT:
				return view.getInt16(read(2));
			case INT:
				return view.getInt32(read(4));
			case LONG:
				return view.getBigInt64(read(8));
			case FLOAT:
				return view.getFloat32(read(4));
			case DOUBLE:
				return view.getFloat64(read(8));
			case BYTE_ARRAY: {
				const length = view.getInt32(read(4));
				const start = read(length);
				return buffer.subarray(start, start + length);
			}
			case STRING:
				return readString();
			case LIST: {
				const listType = buffer[read(1)];
				const length = view.getInt32(read(4));
				const items = [];
				for (let i = 0; i < length; i++) {
					items.push(readPayload(listType));
				}
				return items;
			}
			case COMPOUND: {
				const obj = {};
				while (true) {
					const child = buffer[read(1)];
					if (child === END) {
						return obj;
					}
					obj[readString()] = readPayload(child);
				}
			}
			case INT_ARRAY: {
				const length = view.getInt32(read(4));
				const items = [];
				for (let i = 0; i < length; i++) {
					items.push(view.getInt32(read(4)));
				}
				return items;
			}
			case LONG_ARRAY: {
				const length = view.getInt32(read(4));
				const items = [];
				for (let i = 0; i < length; i++) {
					items.push(view.getBigInt64(read(8)));
				}
				return items;
			}
			default:
				throw new Error(`未知 NBT 类型 ${tag}`);
		}
	}
}

export function encodeNbt(value) {
	const parts = [];
	writeByte(parts, COMPOUND);
	writeString(parts, "");
	writeCompound(parts, value);
	return Buffer.concat(parts);
}

function writeCompound(parts, obj) {
	for (const [key, child] of Object.entries(obj)) {
		writeByte(parts, child.type);
		writeString(parts, key);
		writePayload(parts, child);
	}
	writeByte(parts, END);
}

function writePayload(parts, tag) {
	switch (tag.type) {
		case BYTE:
			writeByte(parts, tag.value);
			return;
		case SHORT: {
			const buf = Buffer.alloc(2);
			buf.writeInt16BE(tag.value);
			parts.push(buf);
			return;
		}
		case INT: {
			const buf = Buffer.alloc(4);
			buf.writeInt32BE(tag.value);
			parts.push(buf);
			return;
		}
		case LONG: {
			const buf = Buffer.alloc(8);
			buf.writeBigInt64BE(BigInt(tag.value));
			parts.push(buf);
			return;
		}
		case STRING:
			writeString(parts, tag.value);
			return;
		case LIST: {
			writeByte(parts, tag.listType);
			const buf = Buffer.alloc(4);
			buf.writeInt32BE(tag.value.length);
			parts.push(buf);
			for (const child of tag.value) {
				writePayload(parts, child);
			}
			return;
		}
		case COMPOUND:
			writeCompound(parts, tag.value);
			return;
		case LONG_ARRAY: {
			const buf = Buffer.alloc(4 + tag.value.length * 8);
			buf.writeInt32BE(tag.value.length);
			tag.value.forEach((value, index) => buf.writeBigInt64BE(BigInt(value), 4 + index * 8));
			parts.push(buf);
			return;
		}
		default:
			throw new Error(`测试编码器不支持类型 ${tag.type}`);
	}
}

function writeByte(parts, value) {
	parts.push(Buffer.from([value & 0xff]));
}

function writeString(parts, value) {
	const text = Buffer.from(value, "utf8");
	const buf = Buffer.alloc(2);
	buf.writeUint16BE(text.length);
	parts.push(buf, text);
}

export const tags = {
	byte: (value) => ({ type: BYTE, value }),
	int: (value) => ({ type: INT, value }),
	string: (value) => ({ type: STRING, value }),
	compound: (value) => ({ type: COMPOUND, value }),
	list: (listType, value) => ({ type: LIST, listType, value }),
	long: (value) => ({ type: LONG, value }),
	longArray: (value) => ({ type: LONG_ARRAY, value }),
};

const SHIFT64 = Array.from({ length: 64 }, (_, index) => BigInt(index));
const MASKS = Array.from({ length: 33 }, (_, bits) => (1n << BigInt(bits)) - 1n);

function bitsForSamples(count, samples) {
	for (let bits = 1; bits <= 32; bits++) {
		const valuesPerLong = Math.floor(64 / bits);
		if (Math.ceil(samples / valuesPerLong) === count) {
			return bits;
		}
	}
	return 0;
}

export function packedIndex(longs, bits, index) {
	const valuesPerLong = Math.floor(64 / bits);
	const longIndex = Math.floor(index / valuesPerLong);
	const offset = (index - longIndex * valuesPerLong) * bits;
	const value = longs[longIndex] ?? 0n;
	return Number((value >> SHIFT64[offset]) & MASKS[bits]);
}

export function heightmapColumns(longs, minY) {
	const bits = bitsForSamples(longs.length, 256);
	if (!bits) {
		return null;
	}
	const columns = new Int16Array(256);
	const sections = new Set();
	for (let index = 0; index < 256; index++) {
		const stored = packedIndex(longs, bits, index);
		if (stored <= 0) {
			columns[index] = -32768;
			continue;
		}
		const blockY = stored + minY - 1;
		if (blockY < -32768 || blockY > 32767) {
			columns[index] = -32768;
			continue;
		}
		columns[index] = blockY;
		sections.add(Math.floor(blockY / 16));
	}
	return { columns, sections };
}

function skipAt(buffer, offset, tag) {
	function need(size) {
		if (offset + size > buffer.length) {
			throw new Error("NBT 超出文件末尾");
		}
	}
	switch (tag) {
		case END:
			return offset;
		case BYTE:
			need(1);
			return offset + 1;
		case SHORT:
			need(2);
			return offset + 2;
		case INT:
		case FLOAT:
			need(4);
			return offset + 4;
		case LONG:
		case DOUBLE:
			need(8);
			return offset + 8;
		case BYTE_ARRAY: {
			need(4);
			const length = buffer.readInt32BE(offset);
			if (length < 0) {
				throw new Error("NBT 长度异常");
			}
			need(4 + length);
			return offset + 4 + length;
		}
		case STRING: {
			need(2);
			const length = buffer.readUInt16BE(offset);
			need(2 + length);
			return offset + 2 + length;
		}
		case LIST: {
			need(5);
			const listType = buffer[offset];
			const length = buffer.readInt32BE(offset + 1);
			offset += 5;
			if (length < 0 || length > 1_000_000) {
				throw new Error("NBT 长度异常");
			}
			if (listType === END) {
				return offset;
			}
			for (let index = 0; index < length; index++) {
				offset = skipAt(buffer, offset, listType);
			}
			return offset;
		}
		case COMPOUND: {
			while (true) {
				need(1);
				const child = buffer[offset];
				offset += 1;
				if (child === END) {
					return offset;
				}
				need(2);
				const nameLength = buffer.readUInt16BE(offset);
				need(2 + nameLength);
				offset += 2 + nameLength;
				offset = skipAt(buffer, offset, child);
			}
		}
		case INT_ARRAY:
		case LONG_ARRAY: {
			need(4);
			const length = buffer.readInt32BE(offset);
			if (length < 0) {
				throw new Error("NBT 长度异常");
			}
			const bytes = length * (tag === INT_ARRAY ? 4 : 8);
			need(4 + bytes);
			return offset + 4 + bytes;
		}
		default:
			throw new Error(`未知 NBT 类型 ${tag}`);
	}
}

function createCursor(buffer) {
	let offset = 0;
	function take(size) {
		if (offset + size > buffer.length) {
			throw new Error("NBT 超出文件末尾");
		}
		const at = offset;
		offset += size;
		return at;
	}
	return {
		offset: () => offset,
		u8: () => buffer[take(1)],
		i8: () => buffer.readInt8(take(1)),
		i16: () => buffer.readInt16BE(take(2)),
		i32: () => buffer.readInt32BE(take(4)),
		string() {
			const length = buffer.readUInt16BE(take(2));
			const at = take(length);
			return buffer.toString("utf8", at, at + length);
		},
		skip(tag) {
			offset = skipAt(buffer, offset, tag);
		},
		longArray() {
			const length = buffer.readInt32BE(take(4));
			if (length < 0 || length > 8192) {
				throw new Error("NBT 长度异常");
			}
			const items = new Array(length);
			for (let index = 0; index < length; index++) {
				items[index] = buffer.readBigInt64BE(take(8));
			}
			return items;
		},
	};
}

function readNumber(cursor, tag) {
	if (tag === BYTE) {
		return cursor.i8();
	}
	if (tag === SHORT) {
		return cursor.i16();
	}
	if (tag === INT) {
		return cursor.i32();
	}
	cursor.skip(tag);
	return null;
}

function readPalette(cursor) {
	const listType = cursor.u8();
	const length = cursor.i32();
	const palette = [];
	if (listType === END || length <= 0) {
		return palette;
	}
	if (length > 4096) {
		throw new Error("调色板过长");
	}
	for (let index = 0; index < length; index++) {
		if (listType === STRING) {
			palette.push(cursor.string());
			continue;
		}
		if (listType !== COMPOUND) {
			cursor.skip(listType);
			palette.push("minecraft:air");
			continue;
		}
		let name = "minecraft:air";
		while (true) {
			const tag = cursor.u8();
			if (tag === END) {
				break;
			}
			const key = cursor.string();
			if (key === "Name" && tag === STRING) {
				name = cursor.string();
			} else {
				cursor.skip(tag);
			}
		}
		palette.push(name);
	}
	return palette;
}

function readBlockStates(cursor) {
	let palette = [];
	let data = [];
	while (true) {
		const tag = cursor.u8();
		if (tag === END) {
			break;
		}
		const name = cursor.string();
		if ((name === "palette" || name === "Palette") && tag === LIST) {
			palette = readPalette(cursor);
		} else if ((name === "data" || name === "Data") && tag === LONG_ARRAY) {
			data = cursor.longArray();
		} else {
			cursor.skip(tag);
		}
	}
	return { palette, data };
}

function readSection(slice) {
	const cursor = createCursor(slice);
	let Y = 0;
	let blockStates = null;
	let legacyPalette = null;
	let legacyData = null;
	while (cursor.offset() < slice.length) {
		const tag = cursor.u8();
		if (tag === END) {
			break;
		}
		const name = cursor.string();
		if (name === "Y") {
			const value = readNumber(cursor, tag);
			if (value != null) {
				Y = value;
			}
		} else if ((name === "block_states" || name === "BlockStates") && tag === COMPOUND) {
			blockStates = readBlockStates(cursor);
		} else if (name === "Palette" && tag === LIST) {
			legacyPalette = readPalette(cursor);
		} else if (name === "BlockStates" && tag === LONG_ARRAY) {
			legacyData = cursor.longArray();
		} else {
			cursor.skip(tag);
		}
	}
	if (!blockStates && legacyPalette) {
		blockStates = { palette: legacyPalette, data: legacyData ?? [] };
	}
	return { Y, block_states: blockStates };
}

function peekSectionY(slice) {
	const cursor = createCursor(slice);
	while (cursor.offset() < slice.length) {
		const tag = cursor.u8();
		if (tag === END) {
			return null;
		}
		const name = cursor.string();
		if (name === "Y") {
			return readNumber(cursor, tag);
		}
		cursor.skip(tag);
	}
	return null;
}

function readSectionList(cursor, buffer) {
	const listType = cursor.u8();
	const length = cursor.i32();
	const slices = [];
	if (listType === END || length <= 0) {
		return slices;
	}
	if (length > 48) {
		throw new Error("区块段过多");
	}
	for (let index = 0; index < length; index++) {
		if (listType !== COMPOUND) {
			cursor.skip(listType);
			continue;
		}
		const start = cursor.offset();
		cursor.skip(COMPOUND);
		slices.push(buffer.subarray(start, cursor.offset()));
	}
	return slices;
}

function readSurfaceMap(cursor) {
	let surface = null;
	let generated = null;
	while (true) {
		const tag = cursor.u8();
		if (tag === END) {
			return surface ?? generated;
		}
		const name = cursor.string();
		if (name === "WORLD_SURFACE" && tag === LONG_ARRAY) {
			surface = cursor.longArray();
		} else if (name === "WORLD_SURFACE_WG" && tag === LONG_ARRAY) {
			generated = cursor.longArray();
		} else {
			cursor.skip(tag);
		}
	}
}

function readChunkCompound(cursor, buffer, found) {
	while (true) {
		const tag = cursor.u8();
		if (tag === END) {
			return;
		}
		const name = cursor.string();
		if (name === "yPos" && tag === INT) {
			found.yPos = cursor.i32();
		} else if (name === "Level" && tag === COMPOUND) {
			readChunkCompound(cursor, buffer, found);
		} else if (name === "Heightmaps" && tag === COMPOUND) {
			const map = readSurfaceMap(cursor);
			if (map) {
				found.heightmap = map;
			}
		} else if ((name === "sections" || name === "Sections") && tag === LIST) {
			found.slices = readSectionList(cursor, buffer);
		} else {
			cursor.skip(tag);
		}
	}
}

// 只保留高度图指向的地表段，光照、生物群系和地下段直接跳过。
export function readMapChunk(buffer, fallbackMinY = -64) {
	if (!Buffer.isBuffer(buffer)) {
		buffer = Buffer.from(buffer);
	}
	const cursor = createCursor(buffer);
	const type = cursor.u8();
	if (type !== COMPOUND) {
		throw new Error(`区块根标签不是 compound（${type}）`);
	}
	cursor.string();
	const found = { yPos: null, heightmap: null, slices: [] };
	readChunkCompound(cursor, buffer, found);
	const minY = found.yPos == null ? fallbackMinY : found.yPos * 16;
	let columns = null;
	let needed = null;
	if (found.heightmap) {
		const parsed = heightmapColumns(found.heightmap, minY);
		if (parsed) {
			columns = parsed.columns;
			needed = parsed.sections;
		}
	}
	const sections = [];
	for (const slice of found.slices) {
		const y = peekSectionY(slice);
		if (needed && !needed.has(y)) {
			continue;
		}
		sections.push(readSection(slice));
	}
	return { minY, columns, sections };
}

export async function decompressChunk(compression, payload) {
	if (compression === 1) {
		return gunzipAsync(payload);
	}
	if (compression === 2) {
		return inflateAsync(payload);
	}
	if (compression === 3) {
		return payload;
	}
	if (compression === 4) {
		const { decompressBlock } = await import("lz4js");
		return decodeLz4Block(payload, decompressBlock);
	}
	throw new Error(`不支持的压缩类型 ${compression}`);
}

const LZ4_MAGIC = "LZ4Block";
const LZ4_HEADER = 21;
const LZ4_RAW = 0x10;
const LZ4_COMPRESSED = 0x20;
const LZ4_LIMIT = 16 * 1024 * 1024;

// 原版用 lz4-java 的 LZ4BlockOutputStream：每块是 "LZ4Block"、方式、压缩长度、原长、校验，最后一块两个长度都是 0。
export function decodeLz4Block(payload, decompressBlock) {
	const buffer = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
	const parts = [];
	let total = 0;
	let offset = 0;
	while (offset < buffer.length) {
		if (offset + LZ4_HEADER > buffer.length || buffer.toString("latin1", offset, offset + 8) !== LZ4_MAGIC) {
			throw new Error("LZ4 区块头不对");
		}
		const method = buffer[offset + 8] & 0xf0;
		const compressed = buffer.readInt32LE(offset + 9);
		const original = buffer.readInt32LE(offset + 13);
		offset += LZ4_HEADER;
		if (compressed === 0 && original === 0) {
			break;
		}
		if (compressed <= 0 || original <= 0 || offset + compressed > buffer.length || total + original > LZ4_LIMIT) {
			throw new Error("LZ4 长度异常");
		}
		if (method === LZ4_RAW) {
			if (compressed !== original) {
				throw new Error("LZ4 长度异常");
			}
			parts.push(buffer.subarray(offset, offset + compressed));
		} else if (method === LZ4_COMPRESSED) {
			const out = Buffer.alloc(original);
			if (decompressBlock(buffer, out, offset, compressed, 0) !== original) {
				throw new Error("LZ4 解压失败");
			}
			parts.push(out);
		} else {
			throw new Error(`LZ4 压缩方式不对 ${method}`);
		}
		total += original;
		offset += compressed;
	}
	if (total === 0) {
		throw new Error("LZ4 区块是空的");
	}
	return parts.length === 1 ? Buffer.from(parts[0]) : Buffer.concat(parts, total);
}
