import { parentPort } from "node:worker_threads";
import { renderTile } from "./render.js";
import { encodeLosslessWebp } from "./webp.js";

const TILE = 256;

parentPort.on("message", async (job) => {
	try {
		const result = await renderTile({
			worldPath: job.worldPath,
			dim: job.dim,
			chunks: job.chunks,
			webpMethod: 6,
		});
		let body = result.body;
		if (!body) {
			body = await encodeLosslessWebp(new Uint8ClampedArray(TILE * TILE * 4), TILE, TILE, 6);
		}
		const bytes = new Uint8Array(body.byteLength);
		bytes.set(body);
		parentPort.postMessage({ id: job.id, body: bytes }, [bytes.buffer]);
	} catch (error) {
		parentPort.postMessage({ id: job.id, error: error.message || "绘制失败" });
	}
});
