import assert from "node:assert/strict";
import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { syncRegions } from "../src/map/sync.js";

test("区域同步只重写有变化的文件", async () => {
	const root = await mkdtemp(path.join(tmpdir(), "sgu-sync-"));
	const payload = Buffer.alloc(8192, 7);
	const mtime = Date.parse("2026-01-02T00:00:00Z");
	const bridge = {
		async regions() {
			return {
				files: [
					{ dim: "overworld", name: "r.0.0.mca", size: payload.length, mtime },
					{ dim: "overworld", name: "../level.dat", size: payload.length, mtime },
				],
			};
		},
		async openRegion() {
			return new Response(payload);
		},
	};
	const first = await syncRegions(bridge, root);
	assert.equal(first.updated, 1);
	const saved = await readFile(path.join(root, "dimensions", "minecraft", "overworld", "region", "r.0.0.mca"));
	assert.equal(saved.length, 8192);
	assert.ok(Math.abs((await stat(path.join(root, "dimensions", "minecraft", "overworld", "region", "r.0.0.mca"))).mtimeMs - mtime) < 2000);
	const second = await syncRegions(bridge, root);
	assert.equal(second.updated, 0);
	await assert.rejects(readFile(path.join(root, "dimensions", "minecraft", "overworld", "region", "..", "..", "..", "level.dat")));
});
