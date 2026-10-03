import http from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";

export async function startHttp({ map, bridge, port }) {
	const page = fileURLToPath(new URL("./web/index.html", import.meta.url));
	const server = http.createServer(async (req, res) => {
		try {
			const url = new URL(req.url, "http://127.0.0.1");
			if (url.pathname === "/" || url.pathname === "/index.html") {
				map.watch();
				const html = await readFile(page);
				res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
				res.end(html);
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
			const tile = /^\/tiles\/(overworld|nether|end)\/0\/(-?\d+)\/(-?\d+)\.png$/.exec(url.pathname);
			if (tile) {
				map.watch();
				try {
					const body = await map.tile(tile[1], Number(tile[2]), Number(tile[3]));
					res.writeHead(200, { "Content-Type": "image/png", "Cache-Control": "no-cache" });
					res.end(body);
					return;
				} catch (error) {
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

	const sockets = new WebSocketServer({ server, path: "/ws" });
	const timer = setInterval(async () => {
		if (sockets.clients.size === 0) {
			return;
		}
		map.watch();
		let payload;
		try {
			payload = JSON.stringify({ type: "players", ...(await bridge.online()) });
		} catch (error) {
			payload = JSON.stringify({ type: "players", players: [], error: error.message });
		}
		for (const client of sockets.clients) {
			if (client.readyState === 1) {
				client.send(payload);
			}
		}
	}, 3000);

	await new Promise((resolve) => server.listen(port, resolve));
	return {
		port: server.address().port,
		close() {
			clearInterval(timer);
			sockets.close();
			server.close();
		},
	};
}

function json(res, body, status = 200) {
	const raw = Buffer.from(JSON.stringify(body));
	res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
	res.end(raw);
}
