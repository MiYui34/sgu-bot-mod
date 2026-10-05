import WebSocket from "ws";
import { ensurePanel } from "./panel.js";

const GROUP_INTENT = 1 << 25;
const MEMBER_INTENT = 1 << 24;
const INTERACTION_INTENT = 1 << 26;

export function startGateway({ qq, config, onGroupMessage, onMemberAdd, onReady, onInteraction, log = console }) {
	let socket;
	let heartbeat;
	let seq = null;
	let sessionId = "";
	let stopped = false;
	let attempt = 0;
	let connecting = false;
	let acked = true;
	let intents = GROUP_INTENT | MEMBER_INTENT | INTERACTION_INTENT;
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
				// 握手中途关闭时 ws 还会发一次 error，没人接会让进程退出。
				previous.on("error", () => {});
				previous.terminate();
			}
			const current = new WebSocket(url);
			socket = current;
			let ready = false;
			current.on("message", (raw) => {
				if (socket !== current) {
					return;
				}
				let payload;
				try {
					payload = JSON.parse(raw.toString());
				} catch {
					log.error?.("QQ 网关消息无法解析");
					return;
				}
				// 事件处理里的异常不能变成未处理的 rejection，否则 Node 会直接退出进程。
				onPayload(payload, current, () => {
					ready = true;
				}).catch((error) => {
					log.error?.(`QQ 事件处理失败：${error.message}`);
					if (payload.op === 10) {
						current.close();
					}
				});
			});
			current.on("close", (code, reason) => {
				if (socket !== current) {
					return;
				}
				clearInterval(heartbeat);
				const text = Buffer.isBuffer(reason) ? reason.toString("utf8") : String(reason || "");
				if (!ready && intents !== GROUP_INTENT && (code === 4013 || code === 4014 || code === 4914 || code === 4915 || /intent/i.test(text))) {
					intents = GROUP_INTENT;
					sessionId = "";
					log.error?.("QQ 未开通群成员或互动事件，已退回原来的订阅。新人入群和确认按钮需要在机器人管理页打开这两类事件。");
				}
				schedule(Boolean(sessionId));
			});
			current.on("error", (error) => {
				log.error?.(`QQ 网关错误：${error.message}`);
			});
		} finally {
			connecting = false;
		}
	}

	async function onPayload(payload, current, markReady) {
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
							intents,
							shard: [0, 1],
							properties: { $os: process.platform, $browser: "sgu-bot", $device: "sgu-bot" },
						},
					};
			current.send(JSON.stringify(identify));
			clearInterval(heartbeat);
			acked = true;
			heartbeat = setInterval(() => {
				if (socket !== current || current.readyState !== WebSocket.OPEN) {
					return;
				}
				// 上一拍没有回 op 11，连接多半已经断了但没收到 close，主动断开重连。
				if (!acked) {
					log.error?.("QQ 网关心跳没有回应，正在重连");
					current.terminate();
					return;
				}
				acked = false;
				current.send(JSON.stringify({ op: 1, d: seq }));
			}, Number(payload.d?.heartbeat_interval) || 30_000);
			return;
		}
		if (payload.op === 11) {
			acked = true;
			return;
		}
		if (payload.op === 9) {
			sessionId = "";
			seq = null;
			current.close();
			return;
		}
		if (payload.op === 7) {
			current.close();
			return;
		}
		if (payload.op !== 0) {
			return;
		}
		if (payload.t === "RESUMED") {
			attempt = 0;
			markReady();
			return;
		}
		if (payload.t === "READY") {
			sessionId = payload.d.session_id;
			attempt = 0;
			markReady();
			log.info?.("QQ 网关已登录");
			try {
				const panelId = await ensurePanel(qq, config);
				log.info?.(`群指令面板已更新 ${panelId || ""}`);
			} catch (error) {
				log.error?.(`指令面板更新失败：${error.message}`);
			}
			await onReady?.();
			return;
		}
		if (payload.t === "GROUP_AT_MESSAGE_CREATE" || payload.t === "GROUP_MEMBER_ADD" || payload.t === "INTERACTION_CREATE") {
			const ids = [payload.id, payload.d?.id].filter(Boolean);
			if (ids.some((id) => seen.has(id))) {
				return;
			}
			for (const id of ids) {
				seen.add(id);
				if (seen.size > 500) {
					seen.delete(seen.values().next().value);
				}
			}
		}
		if (payload.t === "GROUP_AT_MESSAGE_CREATE") {
			await onGroupMessage(payload.d || {}, payload.id);
			return;
		}
		if (payload.t === "GROUP_MEMBER_ADD") {
			await onMemberAdd?.(payload.d || {}, payload.id);
			return;
		}
		if (payload.t === "INTERACTION_CREATE") {
			await onInteraction?.(payload.d || {}, payload.id);
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
