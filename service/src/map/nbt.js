import { inflateSync, gunzipSync } from "node:zlib";

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
	longArray: (value) => ({ type: LONG_ARRAY, value }),
};

export async function decompressChunk(compression, payload) {
	if (compression === 1) {
		return gunzipSync(payload);
	}
	if (compression === 2) {
		return inflateSync(payload);
	}
	if (compression === 3) {
		return payload;
	}
	if (compression === 4) {
		if (payload.length < 5) {
			throw new Error("LZ4 区块太短");
		}
		const size = payload.readInt32LE(0);
		if (size <= 0 || size > 16 * 1024 * 1024) {
			throw new Error(`LZ4 长度异常 ${size}`);
		}
		const { decompressBlock } = await import("lz4js");
		const src = payload.subarray(4);
		const dst = Buffer.alloc(size);
		const written = decompressBlock(src, dst, 0, src.length, 0);
		if (written !== undefined && written < 0) {
			throw new Error("LZ4 解压失败");
		}
		return dst;
	}
	throw new Error(`不支持的压缩类型 ${compression}`);
}
