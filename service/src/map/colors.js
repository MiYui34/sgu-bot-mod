import { packedIndex } from "./nbt.js";
import { brightnessVariant, shadeRgb } from "./map-palette.js";
import { BLOCK_COLOR } from "./vanilla-colors.js";

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

export function colorOf(name, variant = 2) {
	const base = baseColor(name);
	if (!base) {
		return null;
	}
	return shadeRgb(base, variant);
}

function baseColor(name) {
	if (!name || isAir(name)) {
		return null;
	}
	const id = name.includes(":") ? name : `minecraft:${name}`;
	if (Object.hasOwn(BLOCK_COLOR, id)) {
		return BLOCK_COLOR[id];
	}
	return fallbackColor(id);
}

function fallbackColor(id) {
	const bare = id.slice(id.indexOf(":") + 1);
	if (bare === "water" || bare.endsWith("_water") || bare === "bubble_column") {
		return BLOCK_COLOR["minecraft:water"];
	}
	if (bare === "lava" || bare.endsWith("_lava")) {
		return BLOCK_COLOR["minecraft:lava"];
	}
	if (bare.endsWith("_leaves") || bare === "vine") {
		return BLOCK_COLOR["minecraft:oak_leaves"];
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
	const heights = new Array(256).fill(null);
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
		const color = colorAt(index & 15, localY, index >> 4);
		if (!color) {
			continue;
		}
		grid[index] = color;
		heights[index] = blockY;
	}
	return shadeGrid(grid, heights);
}

function usableHeight(value) {
	if (value == null || value === -32768) {
		return null;
	}
	return value;
}

function shadeGrid(grid, heights, northRow = null) {
	const bases = grid.slice();
	for (let index = 0; index < 256; index++) {
		if (!bases[index]) {
			continue;
		}
		const north = (index >> 4) === 0
			? usableHeight(northRow?.[index & 15])
			: usableHeight(heights[index - 16]);
		grid[index] = shadeRgb(bases[index], brightnessVariant(heights[index], north));
	}
	grid.bases = bases;
	grid.heights = heights;
	return grid;
}

export function reshadeNorthEdge(colors, northRow) {
	if (!colors?.bases || !northRow) {
		return colors;
	}
	for (let x = 0; x < 16; x++) {
		if (!colors.bases[x]) {
			continue;
		}
		colors[x] = shadeRgb(colors.bases[x], brightnessVariant(colors.heights[x], usableHeight(northRow[x])));
	}
	return colors;
}

export function surfaceColors(root, northRow = null) {
	if (root.columns && root.columns.length === 256) {
		const grid = colorsFromColumns(root.sections || root.Sections || [], root.columns);
		return northRow ? reshadeNorthEdge(grid, northRow) : grid;
	}
	const sections = root.sections || root.Sections || root.Level?.Sections;
	if (!Array.isArray(sections)) {
		throw new Error("区块里没有 sections");
	}
	const grid = new Array(256).fill(null);
	const heights = new Array(256).fill(null);
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
		const sectionTop = Number(section.Y ?? 0) * 16 + 15;
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
				heights[column] = sectionTop;
				missing--;
			}
			continue;
		}
		const blocks = decodeSection(section);
		if (!blocks) {
			continue;
		}
		const sectionY = Number(section.Y ?? 0);
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
						heights[column] = sectionY * 16 + y;
						missing--;
					}
				}
			}
		}
	}
	return shadeGrid(grid, heights, northRow);
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
