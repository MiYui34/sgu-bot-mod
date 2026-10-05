import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { deflateSync } from "node:zlib";
import lz4 from "lz4js";
import { readRegionChunks } from "../src/map/anvil.js";
import { decodeLz4Block, encodeNbt, tags } from "../src/map/nbt.js";

const SECTOR = 4096;

function stoneChunk() {
	return encodeNbt({
		sections: tags.list(10, [
			tags.compound({
				Y: tags.byte(4),
				block_states: tags.compound({
					palette: tags.list(10, [tags.compound({ Name: tags.string("minecraft:stone") })]),
				}),
			}),
		]),
	});
}

function lz4Header(method, compressed, original) {
	const header = Buffer.alloc(21);
	header.write("LZ4Block", 0, "latin1");
	header[8] = method;
	header.writeInt32LE(compressed, 9);
	header.writeInt32LE(original, 13);
	return header;
}

function lz4Stream(blocks) {
	const parts = [];
	for (const block of blocks) {
		if (block.raw) {
			parts.push(lz4Header(0x10, block.data.length, block.data.length), block.data);
			continue;
		}
		const out = Buffer.alloc(lz4.compressBound(block.data.length));
		const size = lz4.compressBlock(block.data, out, 0, block.data.length, new Uint32Array(1 << 16));
		assert.ok(size > 0);
		parts.push(lz4Header(0x20, size, block.data.length), out.subarray(0, size));
	}
	parts.push(lz4Header(0x10, 0, 0));
	return Buffer.concat(parts);
}

// entries: { index, compression, payload }，payload 为空表示正文在 .mcc 里。
function region(entries) {
	const header = Buffer.alloc(8192);
	const bodies = [];
	let sector = 2;
	for (const entry of entries) {
		const length = entry.payload.length + 1;
		const count = Math.ceil((4 + length) / SECTOR);
		header.writeUInt32BE((sector << 8) | count, entry.index * 4);
		const body = Buffer.alloc(count * SECTOR);
		body.writeUInt32BE(length, 0);
		body[4] = entry.compression;
		entry.payload.copy(body, 5);
		bodies.push(body);
		sector += count;
	}
	return Buffer.concat([header, ...bodies]);
}

test("LZ4Block 格式能还原原版写出的区块", () => {
	const text = Buffer.from("minecraft:stone ".repeat(500));
	const tail = Buffer.from("tail");
	const decoded = decodeLz4Block(lz4Stream([{ data: text }, { data: tail, raw: true }]), lz4.decompressBlock);
	assert.equal(decoded.toString(), text.toString() + "tail");
	assert.throws(() => decodeLz4Block(Buffer.from("not lz4 at all, sorry"), lz4.decompressBlock), /LZ4/);
});

test("坏区块只空出一格，外置 .mcc 和 LZ4 区块都能读", async () => {
	const dir = await mkdtemp(path.join(tmpdir(), "sgu-chunks-"));
	const nbt = stoneChunk();
	const file = path.join(dir, "r.-1.0.mca");
	await writeFile(file, region([
		{ index: 0, compression: 2, payload: deflateSync(nbt) },
		{ index: 1, compression: 2, payload: Buffer.from("garbage that is not deflate") },
		{ index: 2, compression: 0x82, payload: Buffer.alloc(0) },
		{ index: 3, compression: 4, payload: lz4Stream([{ data: nbt }]) },
		{ index: 4, compression: 0x82, payload: Buffer.alloc(0) },
	]));
	await writeFile(path.join(dir, "c.-30.0.mcc"), deflateSync(nbt));
	const errors = [];
	const found = await readRegionChunks(file, [0, 1, 2, 3, 4, 5], -64, (index, error) => errors.push([index, error.message]));
	assert.ok(found.get(0)?.sections.length === 1);
	assert.equal(found.get(1), null);
	assert.ok(found.get(2)?.sections.length === 1);
	assert.ok(found.get(3)?.sections.length === 1);
	assert.equal(found.get(4), null);
	assert.equal(found.get(5), null);
	assert.deepEqual(errors.map(([index]) => index).sort(), [1, 4]);
});
