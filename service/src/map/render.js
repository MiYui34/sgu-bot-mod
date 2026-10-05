import path from "node:path";
import { readRegionChunks } from "./anvil.js";
import { chunkToTile, reshadeNorthEdge, surfaceColors } from "./colors.js";
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

export async function renderTile({ worldPath, dim, chunks, webpMethod = 0 }) {
	const pixels = new Uint8ClampedArray(TILE * TILE * 4);
	let painted = false;
	let sawFile = false;
	const drawn = [];
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
		let broken = 0;
		let firstError = "";
		try {
			decoded = await readRegionChunks(file, group.items.map((item) => item.index), MIN_Y[dim] ?? -64, (index, error) => {
				broken += 1;
				firstError ||= error.message;
			});
			if (broken > 0) {
				console.error(`${dim} r.${group.regionX}.${group.regionZ}.mca 有 ${broken} 个区块读不出，已空出：${firstError}`);
			}
		} catch (error) {
			if (error.code === "ENOENT") {
				continue;
			}
			throw new Error(`${dim} r.${group.regionX}.${group.regionZ}.mca：${error.message}`);
		}
		sawFile = true;
		for (const item of group.items) {
			const root = decoded.get(item.index);
			if (!root) {
				continue;
			}
			let colors;
			try {
				colors = surfaceColors(root);
			} catch (error) {
				console.error(`${dim} 区块 ${item.chunk.chunkX},${item.chunk.chunkZ} 上色失败：${error.message}`);
				continue;
			}
			drawn.push({ chunk: item.chunk, colors });
		}
	}
	const byChunk = new Map(drawn.map((item) => [`${item.chunk.chunkX},${item.chunk.chunkZ}`, item]));
	for (const item of drawn) {
		const north = byChunk.get(`${item.chunk.chunkX},${item.chunk.chunkZ - 1}`);
		if (north?.colors.heights) {
			reshadeNorthEdge(item.colors, north.colors.heights.slice(240, 256));
		}
		painted = true;
		const place = chunkToTile(item.chunk.chunkX, item.chunk.chunkZ, TILE);
		for (let z = 0; z < 16; z++) {
			for (let x = 0; x < 16; x++) {
				const color = item.colors[z * 16 + x];
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
	if (!painted) {
		return { body: null, missing: !sawFile };
	}
	return { body: await encodeLosslessWebp(pixels, TILE, TILE, webpMethod) };
}
