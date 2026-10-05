import { parentPort } from "node:worker_threads";
import { renderTile } from "../src/map/render.js";
import { regionTiles } from "../src/map/tiles.js";

parentPort.on("message", async (job) => {
	try {
		const tiles = regionTiles(job.dim, job.name);
		const bodies = [];
		const transfer = [];
		for (const tile of tiles) {
			const rendered = await renderTile({ worldPath: job.worldPath, dim: job.dim, chunks: tile.chunks });
			if (rendered.missing) {
				throw new Error("区域文件读不到");
			}
			if (rendered.painted && rendered.body) {
				const body = Buffer.from(rendered.body);
				bodies.push({ tileX: tile.tileX, tileZ: tile.tileZ, body });
				transfer.push(body.buffer);
			} else {
				bodies.push({ tileX: tile.tileX, tileZ: tile.tileZ, body: null });
			}
		}
		parentPort.postMessage({ id: job.id, bodies }, transfer);
	} catch (error) {
		parentPort.postMessage({ id: job.id, error: error.message || "绘制失败" });
	}
});
