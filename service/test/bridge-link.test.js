import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createServer } from "node:http";
import test from "node:test";
import { gzipSync } from "node:zlib";
import { WebSocket, WebSocketServer } from "ws";
import { createBridge } from "../src/bridge.js";
import { acceptBridgeSocket, createBridgeLink, decodeFrame, decodeTileFrame, encodeFrame, encodeTileFrame } from "../src/bridge-link.js";

test("二进制帧能还原状态和正文", () => {
	const frame = encodeFrame("12", 200, Buffer.from("mca"));
	const decoded = decodeFrame(frame);
	assert.equal(decoded.id, "12");
	assert.equal(decoded.status, 200);
	assert.equal(decoded.body.toString(), "mca");
	assert.equal(decoded.json, false);
});

test("模组上传的像素包能还原成一张图块", () => {
	const pixels = Buffer.alloc(256 * 256 * 4);
	pixels[0] = 11;
	pixels[3] = 255;
	const packed = gzipSync(pixels);
	const frame = Buffer.alloc(10 + packed.length);
	frame[0] = 4;
	frame[1] = 1;
	frame.writeInt32BE(-2, 2);
	frame.writeInt32BE(4, 6);
	packed.copy(frame, 10);
	const decoded = decodeTileFrame(frame);
	assert.equal(decoded.dim, "nether");
	assert.equal(decoded.tileX, -2);
	assert.equal(decoded.tileZ, 4);
	assert.equal(decoded.pixels.length, 256 * 256 * 4);
	assert.equal(decoded.pixels[0], 11);
	assert.equal(decoded.pixels[3], 255);
	assert.equal(decoded.body, undefined);
	const broken = Buffer.alloc(10 + gzipSync(Buffer.from("nope")).length);
	broken[0] = 4;
	broken[1] = 0;
	gzipSync(Buffer.from("nope")).copy(broken, 10);
	assert.throws(() => decodeTileFrame(broken), /图块像素不对/);
});

test("gzip 数据包能还原成原来的 JSON", () => {
	const raw = Buffer.from(JSON.stringify({ files: [{ name: "r.0.0.mca" }, { name: "r.0.0.mca" }] }));
	const frame = encodeFrame("9", 200, gzipSync(raw), 0x03);
	const decoded = decodeFrame(frame);
	assert.equal(decoded.json, true);
	assert.equal(decoded.status, 200);
	assert.deepEqual(JSON.parse(decoded.body.toString()), { files: [{ name: "r.0.0.mca" }, { name: "r.0.0.mca" }] });
});

test("令牌通过后云服可以经这条连接取回结果", async () => {
	const link = createBridgeLink();
	const server = createServer();
	const sockets = new WebSocketServer({ server, path: "/bridge" });
	sockets.on("connection", (socket) => acceptBridgeSocket(socket, "secret", link, { info() {}, error() {} }));
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	const port = server.address().port;
	try {
		const client = new WebSocket(`ws://127.0.0.1:${port}/bridge`);
		await new Promise((resolve, reject) => {
			client.once("open", resolve);
			client.once("error", reject);
		});
		const accepted = new Promise((resolve) => client.once("message", resolve));
		client.send(JSON.stringify({ op: "auth", token: "secret" }));
		assert.equal(JSON.parse((await accepted).toString()).ok, true);
		const health = new Promise((resolve) => client.once("message", resolve));
		const pending = link.request("GET", "/v1/health?x=1", "");
		const request = JSON.parse((await health).toString());
		assert.equal(request.path, "/v1/health");
		assert.equal(request.query, "x=1");
		client.send(JSON.stringify({ id: request.id, op: "res", status: 200, body: { ok: true } }));
		assert.deepEqual(await pending, { status: 200, body: { ok: true } });
		const fileWait = new Promise((resolve) => client.once("message", resolve));
		const filePending = link.request("GET", "/v1/regions/overworld/r.0.0.mca", "", { binary: true });
		const fileRequest = JSON.parse((await fileWait).toString());
		client.send(encodeFrame(fileRequest.id, 200, Buffer.from("region")));
		const file = await filePending;
		assert.equal(file.status, 200);
		assert.equal(file.body.toString(), "region");
		client.close();
	} finally {
		sockets.close();
		await new Promise((resolve) => server.close(resolve));
	}
});

test("错误令牌会被拒绝", async () => {
	const link = createBridgeLink();
	const server = createServer();
	const sockets = new WebSocketServer({ server, path: "/bridge" });
	sockets.on("connection", (socket) => acceptBridgeSocket(socket, "secret", link, { info() {}, error() {} }));
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	try {
		const client = new WebSocket(`ws://127.0.0.1:${server.address().port}/bridge`);
		await new Promise((resolve, reject) => {
			client.once("open", resolve);
			client.once("error", reject);
		});
		const closed = new Promise((resolve) => client.once("close", resolve));
		client.send(JSON.stringify({ op: "auth", token: "nope" }));
		assert.equal(await closed, 1008);
		assert.equal(link.connected(), false);
	} finally {
		sockets.close();
		await new Promise((resolve) => server.close(resolve));
	}
});

function fakeWebp() {
	const body = Buffer.alloc(12);
	body.write("RIFF", 0);
	body.write("WEBP", 8);
	return body;
}

test("地图连接和指令连接可以同时在线", async () => {
	const link = createBridgeLink();
	const received = [];
	link.setTileHandler((tile) => {
		received.push({ dim: tile.dim, tileX: tile.tileX, tileZ: tile.tileZ, head: tile.body.toString("ascii", 0, 4) });
	});
	const server = createServer();
	const sockets = new WebSocketServer({ server, path: "/bridge" });
	sockets.on("connection", (socket) => acceptBridgeSocket(socket, "secret", link, { info() {}, error() {} }));
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	const port = server.address().port;
	try {
		const command = new WebSocket(`ws://127.0.0.1:${port}/bridge`);
		const map = new WebSocket(`ws://127.0.0.1:${port}/bridge`);
		await Promise.all([opened(command), opened(map)]);
		const commandReady = nextMessage(command);
		const mapReady = nextMessage(map);
		command.send(JSON.stringify({ op: "auth", token: "secret" }));
		map.send(JSON.stringify({ op: "auth", token: "secret", role: "map" }));
		assert.equal(JSON.parse((await commandReady).toString()).ok, true);
		assert.equal(JSON.parse((await mapReady).toString()).ok, true);
		assert.equal(link.connected(), true);
		assert.equal(link.mapConnected(), true);
		const asked = nextMessage(command);
		const pending = link.request("GET", "/v1/health", "");
		const request = JSON.parse((await asked).toString());
		assert.equal(request.path, "/v1/health");
		command.send(JSON.stringify({ id: request.id, op: "res", status: 200, body: { ok: true } }));
		assert.equal((await pending).body.ok, true);
		await link.ingestTile(encodeTileFrame("nether", -2, 3, fakeWebp()));
		assert.deepEqual(received, [{ dim: "nether", tileX: -2, tileZ: 3, head: "RIFF" }]);
		const need = nextMessage(map);
		assert.equal(link.needTiles([{ dim: "overworld", x: 4, z: -1 }]), true);
		assert.deepEqual(JSON.parse((await need).toString()), { op: "need", tiles: [{ dim: "overworld", x: 4, z: -1 }] });
		const commandClosed = closed(command);
		const mapClosed = closed(map);
		command.close();
		map.close();
		await commandClosed;
		await mapClosed;
	} finally {
		sockets.close();
		await new Promise((resolve) => server.close(resolve));
	}
});

function fakeSocket() {
	const socket = new EventEmitter();
	socket.readyState = 1;
	socket.paused = 0;
	socket.resumed = 0;
	socket.pause = () => { socket.paused += 1; };
	socket.resume = () => { socket.resumed += 1; };
	socket.ping = () => {};
	socket.close = () => {};
	socket.terminate = () => {};
	return socket;
}

test("地图图块排队太多时先停读连接，处理完再恢复", async () => {
	const link = createBridgeLink();
	const socket = fakeSocket();
	let release;
	const gate = new Promise((resolve) => { release = resolve; });
	const seen = [];
	link.setTileHandler(async (tile) => {
		await gate;
		seen.push(tile.tileX);
	});
	link.attach(socket, "map");
	const frames = Array.from({ length: 70 }, (_, index) => encodeTileFrame("overworld", index, 0, fakeWebp()));
	for (const frame of frames) {
		socket.emit("message", frame, true);
	}
	assert.equal(socket.paused, 1);
	assert.equal(socket.resumed, 0);
	release();
	await waitFor(() => seen.length === 70);
	assert.equal(socket.resumed, 1);
	assert.deepEqual(seen, frames.map((_, index) => index));
	socket.emit("close");
});

test("坏的地图图块帧只记日志，不会抛出到连接事件里", async () => {
	const link = createBridgeLink();
	const socket = fakeSocket();
	link.attach(socket, "map");
	const errors = [];
	const original = console.error;
	console.error = (message) => errors.push(message);
	try {
		assert.doesNotThrow(() => socket.emit("message", Buffer.from("broken"), true));
		await waitFor(() => errors.length > 0);
		assert.match(errors[0], /地图图块无法解析/);
	} finally {
		console.error = original;
		socket.emit("close");
	}
});

test("没登录的连接出错时直接断开", () => {
	const socket = fakeSocket();
	let terminated = false;
	socket.terminate = () => { terminated = true; };
	socket.send = () => {};
	acceptBridgeSocket(socket, "secret", createBridgeLink(), { info() {}, error() {} });
	assert.doesNotThrow(() => socket.emit("error", new Error("Invalid WebSocket frame")));
	assert.equal(terminated, true);
});

function opened(socket) {
	return new Promise((resolve, reject) => {
		socket.once("open", resolve);
		socket.once("error", reject);
	});
}

function closed(socket) {
	if (socket.readyState === WebSocket.CLOSED) {
		return Promise.resolve();
	}
	return new Promise((resolve) => socket.once("close", resolve));
}

function nextMessage(socket) {
	return new Promise((resolve, reject) => {
		socket.once("message", resolve);
		socket.once("error", reject);
	});
}

test("模组已连上时指令走这条连接", async () => {
	const link = createBridgeLink();
	const bridge = createBridge({ bridgeUrl: "http://127.0.0.1:1", bridgeToken: "secret" }, fetch, link);
	const server = createServer();
	const sockets = new WebSocketServer({ server, path: "/bridge" });
	sockets.on("connection", (socket) => acceptBridgeSocket(socket, "secret", link, { info() {}, error() {} }));
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	try {
		const client = new WebSocket(`ws://127.0.0.1:${server.address().port}/bridge`);
		await new Promise((resolve, reject) => {
			client.once("open", resolve);
			client.once("error", reject);
		});
		const accepted = new Promise((resolve) => client.once("message", resolve));
		client.send(JSON.stringify({ op: "auth", token: "secret" }));
		await accepted;
		const next = new Promise((resolve) => client.once("message", resolve));
		const pending = bridge.command("list");
		const request = JSON.parse((await next).toString());
		assert.equal(request.path, "/v1/commands");
		assert.equal(JSON.parse(request.body).command, "list");
		client.send(JSON.stringify({ id: request.id, op: "res", status: 200, body: { ok: true, output: "玩家" } }));
		assert.equal((await pending).output, "玩家");
		client.close();
	} finally {
		sockets.close();
		await new Promise((resolve) => server.close(resolve));
	}
});

test("还没连过模组时仍立刻走本机接口", async () => {
	const link = createBridgeLink();
	const bridge = createBridge({ bridgeUrl: "http://127.0.0.1:9", bridgeToken: "secret" }, async () => {
		return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "Content-Type": "application/json" } });
	}, link);
	const started = Date.now();
	assert.equal((await bridge.health()).ok, true);
	assert.ok(Date.now() - started < 500);
});

test("指令连接中断后会等它回来", async () => {
	const link = createBridgeLink();
	let fetches = 0;
	const bridge = createBridge({ bridgeUrl: "http://127.0.0.1:1", bridgeToken: "secret" }, async () => {
		fetches += 1;
		throw new Error("不应走本机接口");
	}, link);
	const server = createServer();
	const sockets = new WebSocketServer({ server, path: "/bridge" });
	sockets.on("connection", (socket) => acceptBridgeSocket(socket, "secret", link, { info() {}, error() {} }));
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	const port = server.address().port;
	try {
		const first = new WebSocket(`ws://127.0.0.1:${port}/bridge`);
		await opened(first);
		const ready = nextMessage(first);
		first.send(JSON.stringify({ op: "auth", token: "secret" }));
		await ready;
		first.close();
		const closedAt = Date.now();
		while (link.connected() && Date.now() - closedAt < 1000) {
			await new Promise((resolve) => setTimeout(resolve, 10));
		}
		assert.equal(link.connected(), false);
		const pending = bridge.health();
		await new Promise((resolve) => setTimeout(resolve, 40));
		assert.equal(fetches, 0);
		const second = new WebSocket(`ws://127.0.0.1:${port}/bridge`);
		await opened(second);
		const messages = [];
		second.on("message", (data, isBinary) => {
			if (!isBinary) {
				messages.push(JSON.parse(data.toString()));
			}
		});
		second.send(JSON.stringify({ op: "auth", token: "secret" }));
		const request = await waitFor(() => messages.find((item) => item.op === "req"));
		second.send(JSON.stringify({ id: request.id, op: "res", status: 200, body: { ok: true } }));
		assert.equal((await pending).ok, true);
		assert.equal(fetches, 0);
		second.close();
	} finally {
		sockets.close();
		await new Promise((resolve) => server.close(resolve));
	}
});

async function waitFor(read) {
	const started = Date.now();
	while (Date.now() - started < 2000) {
		const found = read();
		if (found) {
			return found;
		}
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
	throw new Error("没有等到模组请求");
}
