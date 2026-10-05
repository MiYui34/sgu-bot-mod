import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
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
	const regionDir = path.join(root, "dimensions", "minecraft", "overworld", "region");
	await writeFile(path.join(regionDir, "r.9.9.mca"), payload);
	const second = await syncRegions(bridge, root);
	assert.equal(second.updated, 0);
	assert.deepEqual(second.removed, [{ dim: "overworld", name: "r.9.9.mca" }]);
	await assert.rejects(readFile(path.join(regionDir, "r.9.9.mca")));
	await assert.rejects(readFile(path.join(root, "dimensions", "minecraft", "overworld", "region", "..", "..", "..", "level.dat")));
});

test("世界标识变化时清掉上一张图的区域", async () => {
	const root = await mkdtemp(path.join(tmpdir(), "sgu-sync-"));
	const payload = Buffer.alloc(8192, 3);
	const regionDir = path.join(root, "dimensions", "minecraft", "overworld", "region");
	await mkdir(regionDir, { recursive: true });
	await writeFile(path.join(regionDir, "r.9.9.mca"), Buffer.alloc(8192, 1));
	const bridge = {
		async regions() {
			return {
				world: "survival",
				files: [{ dim: "overworld", name: "r.0.0.mca", size: payload.length, mtime: Date.parse("2026-02-02T00:00:00Z") }],
			};
		},
		async openRegion() {
			return new Response(payload);
		},
	};
	const result = await syncRegions(bridge, root, { previousWorld: "test" });
	assert.equal(result.worldChanged, true);
	assert.equal(result.removed.length, 0);
	assert.equal((await readFile(path.join(regionDir, "r.0.0.mca"))).length, 8192);
	await assert.rejects(readFile(path.join(regionDir, "r.9.9.mca")));
});

test("模组一时返回空列表时不删已有的区域", async () => {
	const root = await mkdtemp(path.join(tmpdir(), "sgu-sync-"));
	const regionDir = path.join(root, "dimensions", "minecraft", "overworld", "region");
	await mkdir(regionDir, { recursive: true });
	await writeFile(path.join(regionDir, "r.0.0.mca"), Buffer.alloc(8192, 2));
	const manifest = { files: { "overworld/r.0.0.mca": { size: 8192, mtime: 1 } } };
	const bridge = {
		async regions() {
			return { files: [] };
		},
	};
	const result = await syncRegions(bridge, root, { manifest });
	assert.deepEqual(result.removed, []);
	assert.ok(manifest.files["overworld/r.0.0.mca"]);
	assert.equal((await stat(path.join(regionDir, "r.0.0.mca"))).size, 8192);
});

test("已经画好的区域副本会删掉，未画好的保留", async () => {
	const root = await mkdtemp(path.join(tmpdir(), "sgu-sync-"));
	const payload = Buffer.alloc(8192, 4);
	const mtime = Date.parse("2026-03-03T00:00:00Z");
	const regionDir = path.join(root, "dimensions", "minecraft", "overworld", "region");
	await mkdir(regionDir, { recursive: true });
	const ready = path.join(regionDir, "r.0.0.mca");
	const pending = path.join(regionDir, "r.1.0.mca");
	await writeFile(ready, payload);
	await writeFile(pending, payload);
	const when = new Date(mtime);
	const { utimes } = await import("node:fs/promises");
	await utimes(ready, when, when);
	await utimes(pending, when, when);
	let fetches = 0;
	const manifest = { files: {} };
	const bridge = {
		async regions() {
			return {
				files: [
					{ dim: "overworld", name: "r.0.0.mca", size: payload.length, mtime },
					{ dim: "overworld", name: "r.1.0.mca", size: payload.length, mtime },
				],
			};
		},
		async openRegion() {
			fetches += 1;
			return new Response(payload);
		},
	};
	const result = await syncRegions(bridge, root, {
		manifest,
		discard: true,
		tilesReady: async (_dim, name) => name === "r.0.0.mca",
	});
	assert.equal(fetches, 0);
	assert.equal(result.updated, 0);
	assert.equal(result.released, payload.length);
	await assert.rejects(stat(ready));
	assert.equal((await stat(pending)).size, payload.length);
	assert.equal(manifest.files["overworld/r.0.0.mca"].size, payload.length);
	assert.equal(manifest.files["overworld/r.1.0.mca"], undefined);
});

test("新下载的区域画完后不留在磁盘上", async () => {
	const root = await mkdtemp(path.join(tmpdir(), "sgu-sync-"));
	const payload = Buffer.alloc(8192, 5);
	const mtime = Date.parse("2026-04-04T00:00:00Z");
	const manifest = { files: {} };
	let fetches = 0;
	const bridge = {
		async regions() {
			return { files: [{ dim: "overworld", name: "r.0.0.mca", size: payload.length, mtime }] };
		},
		async openRegion() {
			fetches += 1;
			return new Response(payload);
		},
	};
	let painted = 0;
	const first = await syncRegions(bridge, root, {
		manifest,
		discard: true,
		onRegion: async () => {
			painted += 1;
		},
	});
	assert.equal(first.updated, 1);
	assert.equal(painted, 1);
	assert.equal(first.released, payload.length);
	await assert.rejects(stat(path.join(root, "dimensions", "minecraft", "overworld", "region", "r.0.0.mca")));
	const second = await syncRegions(bridge, root, { manifest, discard: true });
	assert.equal(second.updated, 0);
	assert.equal(fetches, 1);
});
