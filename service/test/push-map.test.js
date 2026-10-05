import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { decodeTileFrame, encodeTileFrame } from "../src/bridge-link.js";
import { createPushPool } from "../src/map/push-pool.js";
import {
	acceptNeed,
	bridgeSocketUrl,
	chunksForTile,
	createSendLimiter,
	pullNext,
	sameStamp,
	tilesForRegion,
	uploadBytesPerSecond,
	workerCount,
} from "../src/map/push-plan.js";
import { createMap } from "../src/map/tiles.js";

test("云服地址会转成地图连接", () => {
	assert.equal(bridgeSocketUrl("https://map.gmhub.top"), "wss://map.gmhub.top/bridge");
	assert.equal(bridgeSocketUrl("wss://map.gmhub.top/bridge"), "wss://map.gmhub.top/bridge");
	assert.equal(bridgeSocketUrl(""), "");
});

test("一个区域对应四张图，负坐标也对齐", () => {
	assert.deepEqual(tilesForRegion("overworld", 0, 0).map((tile) => [tile.tileX, tile.tileZ]), [
		[0, 0],
		[1, 0],
		[0, 1],
		[1, 1],
	]);
	assert.deepEqual(tilesForRegion("nether", -1, -1).map((tile) => [tile.tileX, tile.tileZ]), [
		[-2, -2],
		[-1, -2],
		[-2, -1],
		[-1, -1],
	]);
});

test("视口里的图先上传，后台上传按带宽等待", () => {
	const queue = [{ id: "a", urgent: false }, { id: "b", urgent: false }, { id: "c", urgent: true }];
	assert.equal(pullNext(queue).id, "c");
	assert.equal(pullNext(queue).id, "a");
	let clock = 0;
	const waitFor = createSendLimiter(1000, () => clock);
	assert.equal(waitFor(1000, false), 0);
	assert.equal(waitFor(1000, false), 1000);
	assert.equal(createSendLimiter(1000, () => 0)(5000, true), 0);
	clock += 1000;
	assert.equal(waitFor(1000, false), 0);
	assert.equal(workerCount(["node", "push-map.js"]), 12);
	assert.equal(workerCount(["node", "push-map.js", "--jobs=4"]), 4);
	assert.equal(uploadBytesPerSecond(["node", "push-map.js"], {}), 1_000_000);
});

test("只接收看地图时缺的那几张", () => {
	assert.deepEqual(acceptNeed({ op: "need", tiles: [{ dim: "overworld", x: 1, z: -2 }, { dim: "bad", x: 1, z: 1 }, { dim: "end", x: 1.5, z: 2 }] }), [
		{ dim: "overworld", tileX: 1, tileZ: -2 },
	]);
	assert.equal(sameStamp({ size: 8192, mtime: 10 }, 8192, 10), true);
	assert.equal(sameStamp({ size: 8192, mtime: 10 }, 8192, 11), false);
	const body = Buffer.alloc(12);
	body.write("RIFF", 0);
	body.write("WEBP", 8);
	const decoded = decodeTileFrame(encodeTileFrame("end", 8, -3, body));
	assert.equal(decoded.dim, "end");
	assert.equal(decoded.tileX, 8);
	assert.equal(decoded.tileZ, -3);
	assert.equal(decoded.body.toString("ascii", 0, 4), "RIFF");
});

test("绘制在独立线程里完成，主线程只拿到编码后的图", async () => {
	const pool = createPushPool(1);
	pool.start();
	try {
		const body = await pool.render({
			worldPath: path.join(rootForTest(), "missing"),
			dim: "overworld",
			chunks: chunksForTile(0, 0),
		});
		assert.equal(Buffer.from(body.buffer, body.byteOffset, body.byteLength).toString("ascii", 0, 4), "RIFF");
		assert.equal(Buffer.from(body.buffer, body.byteOffset, body.byteLength).toString("ascii", 8, 12), "WEBP");
	} finally {
		await pool.stop();
	}
});

function rootForTest() {
	return tmpdir();
}

test("地图连接在时缺图向游戏机要，不再在云服上画", async () => {
	const root = await mkdtemp(path.join(tmpdir(), "sgu-remote-"));
	const asked = [];
	const map = createMap({
		worldPath: path.join(root, "world"),
		cacheDir: path.join(root, "tiles"),
		preferRemote: () => true,
		requestTile: (dim, tileX, tileZ) => asked.push({ dim, tileX, tileZ }),
	});
	await assert.rejects(map.tile("overworld", 2, -1), (error) => error.code === "TILE_PENDING");
	assert.deepEqual(asked, [{ dim: "overworld", tileX: 2, tileZ: -1 }]);
	await map.acceptUpload("overworld", 2, -1, Buffer.from("webp"));
	assert.equal(Buffer.from(await map.tile("overworld", 2, -1)).toString(), "webp");
	assert.equal(asked.length, 1);
	const saved = await readFile(path.join(root, "tiles", "overworld", "0", "2", "-1.webp"));
	assert.equal(saved.toString(), "webp");
});
