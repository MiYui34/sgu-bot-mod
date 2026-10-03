const NAMED = {
	"minecraft:stone": [128, 128, 128, 255],
	"minecraft:deepslate": [80, 80, 88, 255],
	"minecraft:cobblestone": [110, 110, 110, 255],
	"minecraft:dirt": [134, 96, 67, 255],
	"minecraft:grass_block": [121, 168, 74, 255],
	"minecraft:short_grass": [112, 160, 70, 255],
	"minecraft:tall_grass": [112, 160, 70, 255],
	"minecraft:sand": [219, 207, 160, 255],
	"minecraft:red_sand": [190, 102, 48, 255],
	"minecraft:gravel": [136, 126, 126, 255],
	"minecraft:water": [47, 92, 196, 220],
	"minecraft:lava": [216, 90, 18, 255],
	"minecraft:oak_log": [109, 85, 50, 255],
	"minecraft:oak_leaves": [59, 122, 40, 255],
	"minecraft:birch_log": [196, 190, 165, 255],
	"minecraft:birch_leaves": [128, 166, 84, 255],
	"minecraft:spruce_log": [88, 68, 42, 255],
	"minecraft:spruce_leaves": [52, 86, 52, 255],
	"minecraft:netherrack": [111, 54, 52, 255],
	"minecraft:nether_bricks": [68, 28, 32, 255],
	"minecraft:soul_sand": [84, 64, 51, 255],
	"minecraft:basalt": [72, 72, 78, 255],
	"minecraft:end_stone": [219, 222, 160, 255],
	"minecraft:obsidian": [20, 16, 32, 255],
	"minecraft:snow": [240, 248, 252, 255],
	"minecraft:ice": [145, 176, 224, 220],
	"minecraft:clay": [160, 166, 179, 255],
	"minecraft:terracotta": [152, 94, 68, 255],
	"minecraft:sandstone": [216, 202, 155, 255],
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
	if (NAMED[name]) {
		return NAMED[name];
	}
	if (name.endsWith("_leaves")) {
		return [70, 130, 55, 255];
	}
	if (name.endsWith("_log") || name.endsWith("_wood")) {
		return [120, 90, 55, 255];
	}
	if (name.includes("ore")) {
		return [140, 140, 140, 255];
	}
	let hash = 0;
	for (const char of name) {
		hash = Math.imul(hash, 31) + char.charCodeAt(0);
	}
	return [48 + (hash & 95), 48 + ((hash >>> 8) & 95), 48 + ((hash >>> 16) & 95), 255];
}

const MASK64 = (1n << 64n) - 1n;

function unsignedShift(value, bits) {
	return (value & MASK64) >> BigInt(bits);
}

function paletteIndex(longs, bits, index) {
	const start = index * bits;
	const longIndex = Math.floor(start / 64);
	const offset = start % 64;
	const mask = (1n << BigInt(bits)) - 1n;
	if (offset + bits <= 64) {
		return Number(unsignedShift(longs[longIndex] ?? 0n, offset) & mask);
	}
	const first = 64 - offset;
	const low = unsignedShift(longs[longIndex] ?? 0n, offset);
	const high = (longs[longIndex + 1] ?? 0n) & ((1n << BigInt(bits - first)) - 1n);
	return Number((low | (high << BigInt(first))) & mask);
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
	const bits = Math.max(4, Math.ceil(Math.log2(palette.length)));
	const data = states.data || states.Data || [];
	for (let i = 0; i < 4096; i++) {
		const index = paletteIndex(data, bits, i);
		blocks[i] = blockName(palette[index] || palette[0]);
	}
	return blocks;
}

export function surfaceColors(root) {
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
