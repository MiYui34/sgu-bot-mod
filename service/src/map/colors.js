import { packedIndex } from "./nbt.js";
import { BLOCK_COLOR } from "./vanilla-colors.js";

// 游戏里会染色的方块。这些值是原版写死的平原/默认色，不是地图色。
const GRASS = [0x91, 0xbd, 0x59, 255];
const FOLIAGE = [0x77, 0xab, 0x2f, 255];
const BIRCH = [0x80, 0xa7, 0x55, 255];
const SPRUCE = [0x61, 0x99, 0x61, 255];
const MANGROVE = [0x92, 0xc6, 0x48, 255];
const WATER = [0x3f, 0x76, 0xe4, 255];
const LILY = [0x20, 0x80, 0x30, 255];
const STEM = [0xe0, 0xc7, 0x1c, 255];
const LAVA = [232, 74, 0, 255];

const TINT = {
	"minecraft:grass_block": GRASS,
	"minecraft:short_grass": GRASS,
	"minecraft:grass": GRASS,
	"minecraft:tall_grass": GRASS,
	"minecraft:fern": GRASS,
	"minecraft:large_fern": GRASS,
	"minecraft:sugar_cane": GRASS,
	"minecraft:bush": GRASS,
	"minecraft:firefly_bush": GRASS,
	"minecraft:leaf_litter": GRASS,
	"minecraft:oak_leaves": FOLIAGE,
	"minecraft:jungle_leaves": FOLIAGE,
	"minecraft:acacia_leaves": FOLIAGE,
	"minecraft:dark_oak_leaves": FOLIAGE,
	"minecraft:azalea_leaves": FOLIAGE,
	"minecraft:flowering_azalea_leaves": FOLIAGE,
	"minecraft:vine": FOLIAGE,
	"minecraft:birch_leaves": BIRCH,
	"minecraft:spruce_leaves": SPRUCE,
	"minecraft:mangrove_leaves": MANGROVE,
	"minecraft:water": WATER,
	"minecraft:bubble_column": WATER,
	"minecraft:water_cauldron": WATER,
	"minecraft:lily_pad": LILY,
	"minecraft:melon_stem": STEM,
	"minecraft:pumpkin_stem": STEM,
	"minecraft:attached_melon_stem": STEM,
	"minecraft:attached_pumpkin_stem": STEM,
	"minecraft:lava": LAVA,
	"minecraft:lava_cauldron": LAVA,
	"minecraft:dandelion": [248, 220, 50, 255],
	"minecraft:sunflower": [240, 200, 40, 255],
	"minecraft:poppy": [200, 40, 35, 255],
	"minecraft:red_tulip": [200, 40, 40, 255],
	"minecraft:rose_bush": [180, 40, 50, 255],
	"minecraft:torchflower": [240, 140, 40, 255],
	"minecraft:orange_tulip": [230, 140, 40, 255],
	"minecraft:blue_orchid": [40, 170, 210, 255],
	"minecraft:allium": [180, 100, 210, 255],
	"minecraft:lilac": [190, 130, 200, 255],
	"minecraft:azure_bluet": [230, 235, 200, 255],
	"minecraft:oxeye_daisy": [220, 220, 190, 255],
	"minecraft:white_tulip": [240, 240, 240, 255],
	"minecraft:lily_of_the_valley": [230, 230, 230, 255],
	"minecraft:pink_tulip": [230, 170, 200, 255],
	"minecraft:peony": [220, 160, 190, 255],
	"minecraft:pink_petals": [232, 168, 186, 255],
	"minecraft:cornflower": [70, 100, 210, 255],
	"minecraft:wither_rose": [40, 30, 30, 255],
	"minecraft:pitcher_plant": [60, 100, 70, 255],
	"minecraft:spore_blossom": [210, 120, 180, 255],
	"minecraft:open_eyeblossom": [230, 150, 50, 255],
	"minecraft:closed_eyeblossom": [180, 170, 160, 255],
};

const DYE_ORDER = ["light_blue", "light_gray", "white", "orange", "magenta", "yellow", "lime", "pink", "gray", "cyan", "purple", "blue", "brown", "green", "red", "black"];
const DYE = {
	white: [255, 255, 255, 255],
	orange: [216, 127, 51, 255],
	magenta: [178, 76, 216, 255],
	light_blue: [102, 153, 216, 255],
	yellow: [229, 229, 51, 255],
	lime: [127, 204, 25, 255],
	pink: [242, 127, 165, 255],
	gray: [76, 76, 76, 255],
	light_gray: [153, 153, 153, 255],
	cyan: [76, 127, 153, 255],
	purple: [127, 63, 178, 255],
	blue: [51, 76, 178, 255],
	brown: [102, 76, 51, 255],
	green: [102, 127, 51, 255],
	red: [153, 51, 51, 255],
	black: [25, 25, 25, 255],
};

const SKIP = new Set([
	"minecraft:air",
	"minecraft:cave_air",
	"minecraft:void_air",
	"minecraft:light",
	"minecraft:structure_void",
]);

export function isAir(name) {
	return SKIP.has(name);
}

export function colorOf(name) {
	if (!name || isAir(name)) {
		return null;
	}
	const id = name.includes(":") ? name : `minecraft:${name}`;
	if (TINT[id]) {
		return TINT[id];
	}
	if (Object.hasOwn(BLOCK_COLOR, id)) {
		return BLOCK_COLOR[id];
	}
	return fallbackColor(id);
}

function fallbackColor(id) {
	const bare = id.slice(id.indexOf(":") + 1);
	if (bare === "water" || bare.endsWith("_water") || bare === "bubble_column") {
		return WATER;
	}
	if (bare === "lava" || bare.endsWith("_lava")) {
		return LAVA;
	}
	if (bare.endsWith("_leaves")) {
		if (bare.includes("birch")) return BIRCH;
		if (bare.includes("spruce")) return SPRUCE;
		if (bare.includes("mangrove")) return MANGROVE;
		return FOLIAGE;
	}
	if (bare.endsWith("_log") || bare.endsWith("_wood") || bare.endsWith("_hyphae") || bare.endsWith("_stem")) {
		return BLOCK_COLOR["minecraft:oak_log"];
	}
	if (bare.endsWith("_ore")) {
		return BLOCK_COLOR["minecraft:stone"];
	}
	for (const dye of DYE_ORDER) {
		if (bare === dye || bare.startsWith(`${dye}_`)) {
			return DYE[dye];
		}
	}
	return BLOCK_COLOR["minecraft:stone"];
}

function longsFor(bits) {
	const valuesPerLong = Math.floor(64 / bits);
	return Math.ceil(4096 / valuesPerLong);
}

// 1.16（20w17a）起，调色板下标按 long 对齐，不会跨到下一个 long。
// 位数优先用调色板算出来的最小值；容器扩容后以 data 的长度核对。
function bitsPerBlock(paletteLength, dataLength) {
	const minimum = Math.max(4, Math.ceil(Math.log2(paletteLength)));
	if (longsFor(minimum) === dataLength) {
		return minimum;
	}
	for (let bits = minimum + 1; bits <= 16; bits++) {
		if (longsFor(bits) === dataLength) {
			return bits;
		}
	}
	return minimum;
}

function paletteIndex(longs, bits, index) {
	return packedIndex(longs, bits, index);
}

function blockName(entry) {
	if (!entry) {
		return "minecraft:air";
	}
	if (typeof entry === "string") {
		return entry;
	}
	return entry.Name || "minecraft:air";
}

function decodeSection(section) {
	const states = section.block_states || section.BlockStates;
	if (!states) {
		return null;
	}
	const palette = states.palette || states.Palette;
	if (!Array.isArray(palette) || palette.length === 0) {
		return null;
	}
	const blocks = new Array(4096);
	if (palette.length === 1) {
		const name = blockName(palette[0]);
		blocks.fill(name);
		return blocks;
	}
	const data = states.data || states.Data || [];
	const bits = bitsPerBlock(palette.length, data.length);
	for (let i = 0; i < 4096; i++) {
		const index = paletteIndex(data, bits, i);
		blocks[i] = blockName(palette[index]);
	}
	return blocks;
}

function prepareSection(section) {
	const states = section.block_states || section.BlockStates;
	if (!states) {
		return () => null;
	}
	const palette = states.palette || states.Palette || [];
	const colors = palette.map((entry) => colorOf(blockName(entry)));
	if (palette.length <= 1) {
		const color = colors[0] ?? null;
		return () => color;
	}
	const data = states.data || states.Data || [];
	const bits = bitsPerBlock(palette.length, data.length);
	return (x, y, z) => colors[paletteIndex(data, bits, (y << 8) | (z << 4) | x)] ?? null;
}

// 高度图给出每一列最高的非空气方块，不用再把整段 4096 个方块展开。
function colorsFromColumns(sections, columns) {
	const byY = new Map();
	for (const section of sections) {
		byY.set(Number(section.Y ?? 0), prepareSection(section));
	}
	const grid = new Array(256).fill(null);
	for (let index = 0; index < 256; index++) {
		const blockY = columns[index];
		if (blockY === -32768) {
			continue;
		}
		const sectionY = Math.floor(blockY / 16);
		const localY = blockY - sectionY * 16;
		if (localY < 0 || localY > 15) {
			continue;
		}
		const colorAt = byY.get(sectionY);
		if (!colorAt) {
			continue;
		}
		grid[index] = colorAt(index & 15, localY, index >> 4);
	}
	return grid;
}

export function surfaceColors(root) {
	if (root.columns && root.columns.length === 256) {
		return colorsFromColumns(root.sections || root.Sections || [], root.columns);
	}
	const sections = root.sections || root.Sections || root.Level?.Sections;
	if (!Array.isArray(sections)) {
		throw new Error("区块里没有 sections");
	}
	const grid = new Array(256).fill(null);
	let missing = 256;
	const sorted = [...sections].sort((a, b) => Number(b.Y ?? 0) - Number(a.Y ?? 0));
	for (const section of sorted) {
		if (missing === 0) {
			break;
		}
		const states = section.block_states || section.BlockStates;
		if (!states) {
			continue;
		}
		const palette = states.palette || states.Palette;
		if (!Array.isArray(palette) || palette.length === 0) {
			continue;
		}
		if (palette.length === 1) {
			const color = colorOf(blockName(palette[0]));
			if (!color) {
				continue;
			}
			for (let column = 0; column < 256; column++) {
				if (grid[column]) {
					continue;
				}
				grid[column] = color;
				missing--;
			}
			continue;
		}
		const blocks = decodeSection(section);
		if (!blocks) {
			continue;
		}
		for (let y = 15; y >= 0 && missing > 0; y--) {
			for (let z = 0; z < 16; z++) {
				for (let x = 0; x < 16; x++) {
					const column = z * 16 + x;
					if (grid[column]) {
						continue;
					}
					const color = colorOf(blocks[(y << 8) | (z << 4) | x]);
					if (color) {
						grid[column] = color;
						missing--;
					}
				}
			}
		}
	}
	return grid;
}

export function chunkToTile(chunkX, chunkZ, tileSize = 256) {
	const blockX = chunkX * 16;
	const blockZ = chunkZ * 16;
	const tileX = Math.floor(blockX / tileSize);
	const tileZ = Math.floor(blockZ / tileSize);
	return {
		tileX,
		tileZ,
		pixelX: blockX - tileX * tileSize,
		pixelZ: blockZ - tileZ * tileSize,
	};
}
