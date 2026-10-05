import assert from "node:assert/strict";
import test from "node:test";
import { WebSocket } from "ws";
import { createBridgeLink } from "../src/bridge-link.js";
import { startHttp } from "../src/http.js";

test("网页和模组的连接可以同时保持", async () => {
	const link = createBridgeLink();
	const server = await startHttp({
		port: 0,
		bridgeToken: "secret",
		link,
		access: {
			view: () => ({ body: { authorized: true }, cookie: "" }),
			authorized: () => true,
		},
		map: {
			watch() {},
			status: () => ({}),
			changesSince: () => ({ revision: 0, reset: false, tiles: [] }),
		},
		bridge: {
			online: async () => ({ players: [] }),
			forward: async () => ({ status: 200, body: {} }),
		},
	});
	const port = server.port;
	try {
		const page = new WebSocket(`ws://127.0.0.1:${port}/ws`);
		await new Promise((resolve, reject) => {
			page.once("open", resolve);
			page.once("error", reject);
		});
		const mod = new WebSocket(`ws://127.0.0.1:${port}/bridge`);
		await new Promise((resolve, reject) => {
			mod.once("open", resolve);
			mod.once("error", reject);
		});
		const accepted = new Promise((resolve) => mod.once("message", resolve));
		mod.send(JSON.stringify({ op: "auth", token: "secret" }));
		assert.equal(JSON.parse((await accepted).toString()).ok, true);
		await new Promise((resolve) => setTimeout(resolve, 200));
		assert.equal(page.readyState, WebSocket.OPEN);
		assert.equal(mod.readyState, WebSocket.OPEN);
		assert.equal(link.connected(), true);
		page.close();
		mod.close();
	} finally {
		await new Promise((resolve) => server.close(resolve));
	}
});
