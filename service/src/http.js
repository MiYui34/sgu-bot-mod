import http from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";
import { acceptBridgeSocket, bridgeTokenOk } from "./bridge-link.js";

export async function startHttp({ map, bridge, port, access, link, bridgeToken = "" }) {
	const page = fileURLToPath(new URL("./web/index.html", import.meta.url));
	const server = http.createServer(async (req, res) => {
		try {
			const url = new URL(req.url, "http://127.0.0.1");
			if (url.pathname.startsWith("/v1/")) {
				await proxyBridge(req, res, url, bridge, bridgeToken);
				return;
			}
			if (url.pathname === "/api/session") {
				const session = access.view(req.headers.cookie);
				return json(res, session.body, 200, session.cookie);
			}
			if (url.pathname === "/" || url.pathname === "/index.html") {
				if (access.authorized(req.headers.cookie)) map.watch();
				const html = await readFile(page);
				res.writeHead(200, {
					"Content-Type": "text/html; charset=utf-8",
					"Cache-Control": "no-store",
				});
				res.end(html);
				return;
			}
			if (!access.authorized(req.headers.cookie)) {
				res.writeHead(401, { "Content-Type": "text/plain; charset=utf-8" });
				res.end("未验证");
				return;
			}
			if (url.pathname === "/api/map/status") {
				return json(res, map.status());
			}
			if (url.pathname === "/api/map/changes") {
				return json(res, map.changesSince(Number(url.searchParams.get("since") || 0)));
			}
			if (url.pathname === "/api/players") {
				try {
					return json(res, await bridge.online());
				} catch (error) {
					return json(res, { players: [], error: error.message });
				}
			}
			const tile = /^\/tiles\/(overworld|nether|end)\/0\/(-?\d+)\/(-?\d+)\.webp$/.exec(url.pathname);
			if (tile) {
				map.watch();
				try {
					const body = await map.tile(tile[1], Number(tile[2]), Number(tile[3]));
					res.writeHead(200, { "Content-Type": "image/webp", "Cache-Control": "no-cache" });
					res.end(body);
					return;
				} catch (error) {
					if (error.code === "TILE_PENDING") {
						res.writeHead(404, { "Cache-Control": "no-store", "Retry-After": "1" });
						res.end();
						return;
					}
					res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
					res.end(error.message);
					return;
				}
			}
			res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
			res.end("未找到");
		} catch (error) {
			res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
			res.end(error.message);
		}
	});

	// 网页只收不发，消息上限压小；坏帧会让 ws 发 error 事件，没人接就会把整个进程带走。
	const sockets = new WebSocketServer({ noServer: true, maxPayload: 4096 });
	sockets.on("connection", (socket, req) => {
		socket.on("error", () => socket.terminate());
		if (!access.authorized(req.headers.cookie)) {
			socket.close();
			return;
		}
		void sendPlayers([socket]);
	});
	const bridgeSockets = new WebSocketServer({ noServer: true, maxPayload: 128 * 1024 * 1024 });
	bridgeSockets.on("connection", (socket) => {
		socket.on("error", () => socket.terminate());
		if (!link) {
			socket.close(1011, "未配置");
			return;
		}
		acceptBridgeSocket(socket, bridgeToken, link);
	});
	server.on("upgrade", (req, socket, head) => {
		const pathname = (req.url || "/").split("?")[0];
		if (pathname === "/ws") {
			sockets.handleUpgrade(req, socket, head, (client) => {
				sockets.emit("connection", client, req);
			});
			return;
		}
		if (pathname === "/bridge") {
			bridgeSockets.handleUpgrade(req, socket, head, (client) => {
				bridgeSockets.emit("connection", client, req);
			});
			return;
		}
		socket.destroy();
	});
	async function sendPlayers(clients) {
		let payload;
		try {
			payload = JSON.stringify({ type: "players", ...(await bridge.online()) });
		} catch (error) {
			payload = JSON.stringify({ type: "players", players: [], error: error.message });
		}
		for (const client of clients) {
			if (client.readyState === 1) {
				client.send(payload);
			}
		}
	}

	let broadcasting = false;
	const timer = setInterval(async () => {
		if (sockets.clients.size === 0 || broadcasting) {
			return;
		}
		map.watch();
		broadcasting = true;
		try {
			await sendPlayers(sockets.clients);
		} finally {
			broadcasting = false;
		}
	}, 3000);

	await new Promise((resolve) => server.listen(port, resolve));
	return {
		port: server.address().port,
		close(callback) {
			clearInterval(timer);
			sockets.close();
			bridgeSockets.close();
			server.close(callback);
		},
	};
}

async function proxyBridge(req, res, url, bridge, bridgeToken) {
	const header = req.headers.authorization || "";
	const bearer = header.toLowerCase().startsWith("bearer ") ? header.slice(7).trim() : "";
	if (!bridgeTokenOk(bearer, bridgeToken) || typeof bridge.forward !== "function") {
		res.writeHead(401, { "Content-Type": "text/plain; charset=utf-8" });
		res.end("未授权");
		return;
	}
	const chunks = [];
	for await (const chunk of req) {
		chunks.push(chunk);
	}
	const rawBody = Buffer.concat(chunks).toString("utf8");
	const binary = /^\/v1\/regions\/(overworld|nether|end)\//.test(url.pathname);
	try {
		const result = await bridge.forward(req.method, `${url.pathname}${url.search}`, rawBody, {
			binary,
			timeout: binary ? 120_000 : 30_000,
		});
		if (binary && Buffer.isBuffer(result.body)) {
			res.writeHead(result.status, { "Content-Type": "application/octet-stream" });
			res.end(result.body);
			return;
		}
		res.writeHead(result.status, { "Content-Type": "application/json; charset=utf-8" });
		res.end(JSON.stringify(result.body ?? {}));
	} catch (error) {
		res.writeHead(error.status || 502, { "Content-Type": "application/json; charset=utf-8" });
		res.end(JSON.stringify({ error: error.message || "模组未连接" }));
	}
}

function json(res, body, status = 200, cookie = "") {
	const raw = Buffer.from(JSON.stringify(body));
	const headers = { "Content-Type": "application/json; charset=utf-8" };
	if (cookie) headers["Set-Cookie"] = cookie;
	res.writeHead(status, headers);
	res.end(raw);
}
