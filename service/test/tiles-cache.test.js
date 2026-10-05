import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { stopPainters } from "../src/map/pool.js";
import { createMap } from "../src/map/tiles.js";

test("换服后丢掉另一张图留下的瓦片", async () => {
	const root = await mkdtemp(path.join(tmpdir(), "sgu-tiles-"));
	const cache = path.join(root, "tiles");
	const map = createMap({ worldPath: path.join(root, "world"), cacheDir: cache });
	const tile = path.join(cache, "overworld", "0", "0", "0.webp");
	await mkdir(path.dirname(tile), { recursive: true });
	await writeFile(tile, "old");
	await map.forgetRegion("overworld", "r.0.0.mca");
	await assert.rejects(stat(tile));
	const beforeReset = map.changesSince(1);
	assert.equal(beforeReset.reset, false);
	const afterReset = path.join(cache, "overworld", "0", "1", "0.webp");
	await mkdir(path.dirname(afterReset), { recursive: true });
	await writeFile(afterReset, "old");
	await map.resetCache();
	await assert.rejects(stat(afterReset));
	const changes = map.changesSince(beforeReset.revision);
	assert.equal(changes.reset, true);
	assert.equal(map.changesSince(changes.revision).reset, false);
});

test("刚打开的网页不收旧变更，服务重启后的旧版本号要整张重载", async () => {
	const root = await mkdtemp(path.join(tmpdir(), "sgu-tiles-"));
	const map = createMap({ worldPath: path.join(root, "world"), cacheDir: path.join(root, "tiles") });
	await map.forgetRegion("overworld", "r.0.0.mca");
	const fresh = map.changesSince(0);
	assert.equal(fresh.reset, false);
	assert.deepEqual(fresh.tiles, []);
	assert.ok(fresh.boot);
	assert.equal(map.changesSince(fresh.revision + 50).reset, true);
	assert.equal(map.changesSince(1).tiles.length, 3);
});

test("变更表有上限，落后太多的网页整张重载", async () => {
	const root = await mkdtemp(path.join(tmpdir(), "sgu-tiles-"));
	const map = createMap({ worldPath: path.join(root, "world"), cacheDir: path.join(root, "tiles") });
	for (let index = 0; index < 2100; index++) {
		await map.notifyRegionFile("overworld", `r.${index}.0.mca`);
	}
	assert.equal(map.changesSince(1).reset, true);
	const recent = map.changesSince(8399);
	assert.equal(recent.reset, false);
	assert.deepEqual(recent.tiles, ["overworld/0/4199/1"]);
});

test("已有瓦片立刻返回", async () => {
	const root = await mkdtemp(path.join(tmpdir(), "sgu-tiles-"));
	const cache = path.join(root, "tiles");
	const map = createMap({ worldPath: path.join(root, "world"), cacheDir: cache });
	const tile = path.join(cache, "overworld", "0", "0", "0.webp");
	await mkdir(path.dirname(tile), { recursive: true });
	await writeFile(tile, "cached");
	await map.notifyRegionFile("overworld", "r.0.0.mca");
	const started = Date.now();
	const body = await map.tile("overworld", 0, 0);
	assert.equal(Buffer.from(body).toString(), "cached");
	assert.ok(Date.now() - started < 1000);
	assert.equal(await readFile(tile, "utf8"), "cached");
	await stopPainters();
});

test("还没画好的瓦片不能当成空白图", async () => {
	const root = await mkdtemp(path.join(tmpdir(), "sgu-tiles-"));
	const map = createMap({ worldPath: path.join(root, "world"), cacheDir: path.join(root, "tiles") });
	await assert.rejects(map.tile("overworld", 3, 3), (error) => error.code === "TILE_PENDING");
	await stopPainters();
});

test("全量加载时还没画好的瓦片不能当成空白图", async () => {
	const root = await mkdtemp(path.join(tmpdir(), "sgu-tiles-"));
	const cache = path.join(root, "tiles");
	const lock = path.join(root, "preload.lock");
	await writeFile(lock, JSON.stringify({ pid: process.pid, started: Date.now() }));
	const map = createMap({
		worldPath: path.join(root, "world"),
		cacheDir: cache,
		preloadLock: lock,
	});
	await assert.rejects(map.tile("overworld", 2, 2), (error) => error.code === "TILE_PENDING");
	await stopPainters();
});
