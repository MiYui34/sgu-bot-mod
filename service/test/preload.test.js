import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { MAP_COLOR_EPOCH } from "../src/map/map-palette.js";
import { acquirePreloadLock, preloadActive, preloadLockPath, releasePreloadLock } from "../src/map/preload-lock.js";
import { regionAction } from "../src/map/preload-plan.js";
import { regionTiles } from "../src/map/tiles.js";

const file = { size: 8192, mtime: 1_000_000 };

test("已按当前颜色画好的区域不再下载", () => {
	const entry = { size: 8192, mtime: 1_000_000, color: MAP_COLOR_EPOCH };
	assert.equal(regionAction({ entry, file, tilesReady: true, epoch: MAP_COLOR_EPOCH, force: false, localExists: false }), "skip");
	assert.equal(regionAction({ entry, file, tilesReady: true, epoch: MAP_COLOR_EPOCH, force: false, localExists: true }), "drop");
	assert.equal(regionAction({ entry, file, tilesReady: false, epoch: MAP_COLOR_EPOCH, force: false, localExists: true }), "paint");
	assert.equal(regionAction({ entry: { ...entry, color: 0 }, file, tilesReady: true, epoch: MAP_COLOR_EPOCH, force: false, localExists: false }), "paint");
	assert.equal(regionAction({ entry, file, tilesReady: true, epoch: MAP_COLOR_EPOCH, force: true, localExists: false }), "paint");
});

test("一个区域对应四张对齐的瓦片", () => {
	const tiles = regionTiles("overworld", "r.0.0.mca");
	assert.deepEqual(tiles.map((tile) => [tile.tileX, tile.tileZ]), [[0, 0], [1, 0], [0, 1], [1, 1]]);
	assert.equal(tiles[0].chunks.length, 256);
	assert.deepEqual(regionTiles("overworld", "r.-1.0.mca").map((tile) => tile.tileX), [-2, -1, -2, -1]);
	assert.deepEqual(regionTiles("nope", "r.0.0.mca"), []);
});

test("全量锁只认还活着的进程", async () => {
	const root = await mkdtemp(path.join(tmpdir(), "sgu-preload-"));
	const lock = preloadLockPath(root);
	await writeFile(lock, JSON.stringify({ pid: 99999999, started: 1 }));
	assert.equal(await preloadActive(lock), false);
	await assert.rejects(readFile(lock, "utf8"));
	await acquirePreloadLock(lock);
	assert.equal(await preloadActive(lock), true);
	await releasePreloadLock(lock);
	assert.equal(await preloadActive(lock), false);
	await rm(root, { recursive: true, force: true });
});
