import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createRegionFetcher } from "../src/map/fetch-region.js";
import { regionPath } from "../src/map/sync.js";

test("眼前没有的区域会先下载，已经有的不再重复拉", async () => {
	const root = await mkdtemp(path.join(tmpdir(), "sgu-region-"));
	const payload = Buffer.alloc(8192, 4);
	let opens = 0;
	const bridge = {
		async regions() {
			return {
				files: [{ dim: "overworld", name: "r.1.-2.mca", size: payload.length, mtime: Date.now() }],
			};
		},
		async forward(method, pathname) {
			opens += 1;
			assert.equal(method, "GET");
			assert.equal(pathname, "/v1/regions/overworld/r.1.-2.mca");
			return { status: 200, body: payload };
		},
	};
	const ensure = createRegionFetcher(bridge, root);
	assert.equal(await ensure("overworld", "r.1.-2.mca"), "ready");
	assert.equal(await ensure("overworld", "r.1.-2.mca"), "ready");
	assert.equal(opens, 1);
	const saved = await readFile(regionPath(root, "overworld", "r.1.-2.mca"));
	assert.equal(saved.length, 8192);
	assert.equal(await ensure("overworld", "r.8.8.mca"), "absent");
	assert.equal(opens, 1);
});
