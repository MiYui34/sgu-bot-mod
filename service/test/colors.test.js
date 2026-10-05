import assert from "node:assert/strict";
import test from "node:test";
import { chunkIndex, readChunkNbtFromBuffer, writeTestRegion } from "../src/map/anvil.js";
import { colorOf, reshadeNorthEdge, surfaceColors } from "../src/map/colors.js";
import { encodeNbt, readMapChunk, tags } from "../src/map/nbt.js";

function packAligned(indices, bits) {
	const valuesPerLong = Math.floor(64 / bits);
	const mask = (1n << BigInt(bits)) - 1n;
	const longs = [];
	for (let i = 0; i < indices.length; i++) {
		const longIndex = Math.floor(i / valuesPerLong);
		const offset = (i % valuesPerLong) * bits;
		longs[longIndex] = (longs[longIndex] ?? 0n) | ((BigInt(indices[i]) & mask) << BigInt(offset));
	}
	return longs;
}

test("5 位调色板按 long 对齐后，方块落在正确的坐标", () => {
	const palette = [{ Name: "minecraft:stone" }];
	for (let i = 0; i < 16; i++) {
		palette.push({ Name: "minecraft:sand" });
	}
	const indices = new Array(4096).fill(0);
	const x = 5;
	const z = 3;
	const y = 15;
	indices[(y << 8) | (z << 4) | x] = 1;
	const colors = surfaceColors({
		sections: [{
			Y: 4,
			block_states: { palette, data: packAligned(indices, 5) },
		}],
	});
	assert.deepEqual(colors[z * 16 + x], [213, 201, 140, 255]);
	assert.deepEqual(colors[0], [96, 96, 96, 255]);
	assert.equal(colors.filter((color) => color && color[0] === 213).length, 1);
});

function packSamples(values, bits) {
	const valuesPerLong = Math.floor(64 / bits);
	const mask = (1n << BigInt(bits)) - 1n;
	const longs = Array.from({ length: Math.ceil(values.length / valuesPerLong) }, () => 0n);
	for (let index = 0; index < values.length; index++) {
		const longIndex = Math.floor(index / valuesPerLong);
		const offset = (index % valuesPerLong) * bits;
		longs[longIndex] |= (BigInt(values[index]) & mask) << BigInt(offset);
	}
	return longs;
}

function block(name) {
	return tags.compound({ Name: tags.string(name) });
}

test("高度图只读取地表所在的段", async () => {
	const palette = [block("minecraft:stone")];
	for (let index = 0; index < 16; index++) {
		palette.push(block("minecraft:sand"));
	}
	const indices = new Array(4096).fill(0);
	const x = 5;
	const z = 3;
	indices[(15 << 8) | (z << 4) | x] = 1;
	const heights = new Array(256).fill(129);
	heights[z * 16 + x] = 144;
	const buried = packSamples(new Array(4096).fill(1), 5);
	const nbt = encodeNbt({
		DataVersion: tags.int(3950),
		Status: tags.string("minecraft:full"),
		InhabitedTime: tags.long(99),
		yPos: tags.int(-4),
		Heightmaps: tags.compound({
			MOTION_BLOCKING: tags.longArray(packSamples(new Array(256).fill(1), 9)),
			WORLD_SURFACE: tags.longArray(packSamples(heights, 9)),
		}),
		sections: tags.list(10, [
			tags.compound({
				Y: tags.byte(10),
				block_states: tags.compound({
					palette: tags.list(10, [block("minecraft:dirt")]),
				}),
			}),
			tags.compound({
				Y: tags.byte(4),
				block_states: tags.compound({
					palette: tags.list(10, palette),
					data: tags.longArray(packAligned(indices, 5)),
				}),
			}),
			tags.compound({
				Y: tags.byte(-4),
				block_states: tags.compound({
					palette: tags.list(10, [block("minecraft:stone"), block("minecraft:sand")]),
					data: tags.longArray(buried),
				}),
			}),
		]),
	});
	const region = writeTestRegion([{ localX: 0, localZ: 0, nbt }]);
	const root = await readChunkNbtFromBuffer(region, chunkIndex(0, 0), 0);
	assert.equal(root.minY, -64);
	assert.deepEqual(root.sections.map((section) => section.Y), [4]);
	const colors = surfaceColors(root);
	assert.deepEqual(colors[z * 16 + x], [247, 233, 163, 255]);
	assert.deepEqual(colors[0], [96, 96, 96, 255]);
	assert.equal(colors.filter((color) => color && color[0] === 247).length, 1);
	assert.equal(colors.some((color) => color && color[0] === 151 && color[1] === 109), false);
});

test("没有高度图时仍按整段从上往下取地表", () => {
	const root = readMapChunk(encodeNbt({
		sections: tags.list(10, [
			tags.compound({
				Y: tags.byte(4),
				block_states: tags.compound({
					palette: tags.list(10, [block("minecraft:stone")]),
				}),
			}),
		]),
	}), -64);
	assert.equal(root.columns, null);
	assert.deepEqual(surfaceColors(root)[0], [96, 96, 96, 255]);
});

test("方块颜色使用 1.21.9 地图色的四个状态，玻璃不占地表", () => {
	assert.deepEqual(colorOf("minecraft:stone"), [112, 112, 112, 255]);
	assert.deepEqual(colorOf("minecraft:stone", 0), [79, 79, 79, 255]);
	assert.deepEqual(colorOf("minecraft:stone", 1), [96, 96, 96, 255]);
	assert.deepEqual(colorOf("minecraft:stone", 3), [59, 59, 59, 255]);
	assert.deepEqual(colorOf("minecraft:grass_block"), [127, 178, 56, 255]);
	assert.deepEqual(colorOf("minecraft:water"), [64, 64, 255, 255]);
	assert.deepEqual(colorOf("minecraft:oak_leaves"), [0, 124, 0, 255]);
	assert.equal(colorOf("minecraft:glass"), null);
	assert.deepEqual(colorOf("minecraft:orange_wool"), [216, 127, 51, 255]);
	assert.deepEqual(colorOf("minecraft:not_a_real_block"), [112, 112, 112, 255]);
});

test("比北边高用亮色，低两格用最暗色", () => {
	const columns = new Array(256).fill(8);
	columns[16] = 10;
	columns[32] = 7;
	const colors = surfaceColors({
		columns,
		sections: [{
			Y: 0,
			block_states: { palette: [{ Name: "minecraft:stone" }] },
		}],
	});
	assert.deepEqual(colors[0], [96, 96, 96, 255]);
	assert.deepEqual(colors[16], [112, 112, 112, 255]);
	assert.deepEqual(colors[32], [59, 59, 59, 255]);
	const north = surfaceColors({
		columns: new Array(256).fill(20),
		sections: [{
			Y: 1,
			block_states: { palette: [{ Name: "minecraft:stone" }] },
		}],
	});
	reshadeNorthEdge(colors, north.heights.slice(240, 256));
	assert.deepEqual(colors[0], [59, 59, 59, 255]);
});
