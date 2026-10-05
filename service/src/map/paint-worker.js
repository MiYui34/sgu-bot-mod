import { parentPort } from "node:worker_threads";
import { renderTile } from "./render.js";

parentPort.on("message", async (job) => {
	try {
		const result = await renderTile(job);
		let body = null;
		if (result.body) {
			body = new Uint8Array(result.body.byteLength);
			body.set(result.body);
		}
		parentPort.postMessage({ id: job.id, painted: Boolean(body), missing: Boolean(result.missing), body }, body ? [body.buffer] : []);
	} catch (error) {
		parentPort.postMessage({ id: job.id, error: error.message || "绘制失败" });
	}
});
