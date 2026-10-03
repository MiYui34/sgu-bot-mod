import WebSocket from "ws";
import { ensurePanel } from "./panel.js";

const INTENT = 1 << 25;

export function startGateway({ qq, config, onGroupMessage, log = console }) {
	let socket;
	let heartbeat;
	let seq = null;
	let sessionId = "";
	let stopped = false;
	let attempt = 0;
	let connecting = false;
	const seen = new Set();

	async function connect(resume) {
		if (stopped || connecting) {
			return;
		}
		connecting = true;
		try {
			const gateway = await qq.gateway();
			if (stopped) {
				return;
			}
			const url = gateway.url || "wss://api.bot.qq.com/websocket";
			const previous = socket;
			if (previous) {
				previous.removeAllListeners();
				previous.close();
			}
			const current = new WebSocket(url);
			socket = current;
			current.on("message", (raw) => {
				if (socket !== current) {
					return;
				}
				void onPayload(JSON.parse(raw.toString()), current);
			});
			current.on("close", () => {
				if (socket !== current) {
					return;
				}
				clearInterval(heartbeat);
				schedule(Boolean(sessionId));
			});
			current.on("error", (error) => {
				log.error?.(`QQ 网关错误：${error.message}`);
			});
		} finally {
			connecting = false;
		}
	}

	async function onPayload(payload, current) {
		if (typeof payload.s === "number") {
			seq = payload.s;
		}
		if (payload.op === 10) {
			const token = `QQBot ${await qq.accessToken()}`;
			const identify = sessionId
				? { op: 6, d: { token, session_id: sessionId, seq } }
				: {
						op: 2,
						d: {
							token,
							intents: INTENT,
							shard: [0, 1],
							properties: { $os: process.platform, $browser: "sgu-bot", $device: "sgu-bot" },
						},
					};
			current.send(JSON.stringify(identify));
			clearInterval(heartbeat);
			heartbeat = setInterval(() => {
				if (socket?.readyState === WebSocket.OPEN) {
					socket.send(JSON.stringify({ op: 1, d: seq }));
				}
			}, payload.d.heartbeat_interval);
			return;
		}
		if (payload.op === 9) {
			sessionId = "";
			seq = null;
			return;
		}
		if (payload.op === 7) {
			current.close();
			return;
		}
		if (payload.op !== 0) {
			return;
		}
		if (payload.t === "READY") {
			sessionId = payload.d.session_id;
			attempt = 0;
			log.info?.("QQ 网关已登录");
			try {
				const panelId = await ensurePanel(qq, config);
				log.info?.(`群指令面板已更新 ${panelId || ""}`);
			} catch (error) {
				log.error?.(`指令面板更新失败：${error.message}`);
			}
			return;
		}
		if (payload.t === "GROUP_AT_MESSAGE_CREATE") {
			const id = payload.d?.id || payload.id;
			if (id && seen.has(id)) {
				return;
			}
			if (id) {
				seen.add(id);
				if (seen.size > 500) {
					seen.delete(seen.values().next().value);
				}
			}
			await onGroupMessage(payload.d || {}, payload.id);
		}
	}

	function schedule(resume) {
		if (stopped) {
			return;
		}
		attempt += 1;
		const delay = Math.min(30_000, 1000 * 2 ** Math.min(attempt, 5));
		setTimeout(() => {
			connect(resume).catch((error) => {
				log.error?.(`QQ 网关连接失败：${error.message}`);
				schedule(resume);
			});
		}, delay);
	}

	connect(false).catch((error) => {
		log.error?.(`QQ 网关连接失败：${error.message}`);
		schedule(false);
	});

	return {
		stop() {
			stopped = true;
			clearInterval(heartbeat);
			socket?.close();
		},
	};
}
