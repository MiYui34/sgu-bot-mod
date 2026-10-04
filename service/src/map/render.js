import path from "node:path";
import { readRegionChunks } from "./anvil.js";
import { chunkToTile, surfaceColors } from "./colors.js";
import { encodeLosslessWebp } from "./webp.js";

export const DIMENSIONS = {
	overworld: ["dimensions", "minecraft", "overworld", "region"],
	nether: ["dimensions", "minecraft", "the_nether", "region"],
	end: ["dimensions", "minecraft", "the_end", "region"],
};

const MIN_Y = {
	overworld: -64,
	nether: 0,
	end: 0,
};

const TILE = 256;

export async function renderTile({ worldPath, dim, chunks }) {
	const pixels = new Uint8ClampedArray(TILE * TILE * 4);
	let painted = false;
	const grouped = new Map();
	for (const chunk of chunks) {
		const regionX = Math.floor(chunk.chunkX / 32);
		const regionZ = Math.floor(chunk.chunkZ / 32);
		const localX = chunk.chunkX - regionX * 32;
		const localZ = chunk.chunkZ - regionZ * 32;
		const file = path.join(worldPath, ...DIMENSIONS[dim], `r.${regionX}.${regionZ}.mca`);
		let group = grouped.get(file);
		if (!group) {
			group = { regionX, regionZ, items: [] };
			grouped.set(file, group);
		}
		group.items.push({ chunk, index: localX + localZ * 32 });
	}
	for (const [file, group] of grouped) {
		let decoded;
		try {
			decoded = await readRegionChunks(file, group.items.map((item) => item.index), MIN_Y[dim] ?? -64);
		} catch (error) {
			if (error.code === "ENOENT") {
				continue;
			}
			throw new Error(`${dim} r.${group.regionX}.${group.regionZ}.mca：${error.message}`);
		}
		for (const item of group.items) {
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
					const offset = (TILE * py + px) << 2;
					pixels[offset] = color[0];
					pixels[offset + 1] = color[1];
					pixels[offset + 2] = color[2];
					pixels[offset + 3] = color[3];
				}
			}
		}
	}
	if (!painted) {
		return { body: null };
	}
	return { body: await encodeLosslessWebp(pixels, TILE, TILE) };
}
