import { timingSafeEqual } from "node:crypto";
import { gunzipSync } from "node:zlib";

// 版本 1：版本、id 长度、id、状态码、正文。
// 版本 2：同样的头之后多 1 字节标记。标记第 0 位表示正文是 gzip，第 1 位表示正文是 JSON。
export function encodeFrame(id, status, body, flags = null) {
	const idBytes = Buffer.from(String(id));
	const payload = Buffer.isBuffer(body) ? body : Buffer.from(body);
	const versioned = flags !== null && flags !== undefined;
	const frame = Buffer.alloc((versioned ? 6 : 5) + idBytes.length + payload.length);
	frame[0] = versioned ? 2 : 1;
	frame.writeUInt16BE(idBytes.length, 1);
	idBytes.copy(frame, 3);
	const offset = 3 + idBytes.length;
	frame.writeUInt16BE(status, offset);
	if (!versioned) {
		payload.copy(frame, offset + 2);
		return frame;
	}
	frame[offset + 2] = flags;
	payload.copy(frame, offset + 3);
	return frame;
}

export function decodeFrame(buffer) {
	const frame = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
	if (frame.length < 5 || (frame[0] !== 1 && frame[0] !== 2)) {
		throw new Error("无法识别模组回传的数据");
	}
	const idLength = frame.readUInt16BE(1);
	const offset = 3 + idLength;
	if (frame[0] === 1) {
		if (frame.length < offset + 2) {
			throw new Error("无法识别模组回传的数据");
		}
		return {
			id: frame.subarray(3, offset).toString("utf8"),
			status: frame.readUInt16BE(offset),
			body: Buffer.from(frame.subarray(offset + 2)),
			json: false,
		};
	}
	if (frame.length < offset + 3) {
		throw new Error("无法识别模组回传的数据");
	}
	const flags = frame[offset + 2];
	let body = Buffer.from(frame.subarray(offset + 3));
	if ((flags & 1) !== 0) {
		body = gunzipSync(body);
	}
	return {
		id: frame.subarray(3, offset).toString("utf8"),
		status: frame.readUInt16BE(offset),
		body,
		json: (flags & 2) !== 0,
	};
}

const TILE_DIMS = ["overworld", "nether", "end"];

export function encodeTileFrame(dim, tileX, tileZ, body) {
	const dimIndex = TILE_DIMS.indexOf(dim);
	const payload = Buffer.isBuffer(body)
		? body
		: ArrayBuffer.isView(body)
			? Buffer.from(body.buffer, body.byteOffset, body.byteLength)
			: Buffer.from(body);
	if (dimIndex < 0 || !Number.isInteger(tileX) || !Number.isInteger(tileZ)) {
		throw new Error("图块坐标不对");
	}
	const frame = Buffer.alloc(10 + payload.length);
	frame[0] = 3;
	frame[1] = dimIndex;
	frame.writeInt32BE(tileX, 2);
	frame.writeInt32BE(tileZ, 6);
	payload.copy(frame, 10);
	return frame;
}

export function decodeTileFrame(buffer) {
	const frame = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
	if (frame.length < 10 || (frame[0] !== 3 && frame[0] !== 4)) {
		throw new Error("无法识别地图图块");
	}
	const dim = TILE_DIMS[frame[1]];
	const tileX = frame.readInt32BE(2);
	const tileZ = frame.readInt32BE(6);
	const body = Buffer.from(frame.subarray(10));
	if (!dim || Math.abs(tileX) > 1_000_000 || Math.abs(tileZ) > 1_000_000) {
		throw new Error("无法识别地图图块");
	}
	if (frame[0] === 4) {
		if (body.length > 2 * 1024 * 1024) {
			throw new Error("图块像素不对");
		}
		let pixels;
		try {
			pixels = gunzipSync(body, { maxOutputLength: 256 * 256 * 4 });
		} catch {
			throw new Error("图块像素不对");
		}
		if (pixels.length !== 256 * 256 * 4) {
			throw new Error("图块像素不对");
		}
		return { dim, tileX, tileZ, pixels: new Uint8ClampedArray(pixels) };
	}
	if (frame.length < 22 || body.length > 2 * 1024 * 1024 || body.toString("ascii", 0, 4) !== "RIFF" || body.toString("ascii", 8, 12) !== "WEBP") {
		throw new Error(frame.length < 22 ? "无法识别地图图块" : "图块不是 WebP");
	}
	return { dim, tileX, tileZ, body };
}

export function bridgeTokenOk(provided, expected) {
	if (typeof provided !== "string" || typeof expected !== "string" || expected.length === 0) {
		return false;
	}
	const left = Buffer.from(provided);
	const right = Buffer.from(expected);
	if (left.length !== right.length) {
		return false;
	}
	return timingSafeEqual(left, right);
}

export function createBridgeLink() {
	const roles = {
		command: { socket: null, beat: null },
		map: { socket: null, beat: null },
	};
	let nextId = 0;
	let tileHandler = null;
	let commandReady = false;
	let sawCommand = false;
	const waiters = new Map();
	const connectWaiters = [];

	function connected() {
		return commandReady && roles.command.socket?.readyState === 1;
	}

	function commandSeen() {
		return sawCommand;
	}

	function whenConnected(timeout) {
		if (connected()) {
			return Promise.resolve(true);
		}
		return new Promise((resolve) => {
			let settled = false;
			const finish = (value) => {
				if (settled) {
					return;
				}
				settled = true;
				clearTimeout(timer);
				resolve(value);
			};
			const timer = setTimeout(() => {
				const index = connectWaiters.indexOf(wake);
				if (index >= 0) {
					connectWaiters.splice(index, 1);
				}
				finish(false);
			}, timeout);
			timer.unref?.();
			function wake() {
				const index = connectWaiters.indexOf(wake);
				if (index >= 0) {
					connectWaiters.splice(index, 1);
				}
				finish(connected());
			}
			connectWaiters.push(wake);
			if (connected()) {
				wake();
			}
		});
	}

	function mapConnected() {
		return roles.map.socket?.readyState === 1;
	}

	function failAll(message) {
		for (const [id, waiter] of waiters) {
			clearTimeout(waiter.timer);
			waiters.delete(id);
			const error = new Error(message);
			error.status = 503;
			waiter.reject(error);
		}
	}

	function settle(id, result) {
		const waiter = waiters.get(id);
		if (!waiter) {
			return;
		}
		clearTimeout(waiter.timer);
		waiters.delete(id);
		waiter.resolve(result);
	}

	async function ingestTile(data) {
		const tile = decodeTileFrame(data);
		return tileHandler?.(tile);
	}

	// 云端编码 WebP 比模组上传慢时，图块会在内存里越堆越多；堆到上限就先停读这条连接。
	const TILE_BACKLOG = 64;
	const tileQueue = [];
	let tileBusy = false;
	let pausedSocket = null;

	function onMapMessage(socket, data, isBinary) {
		if (!isBinary) {
			return;
		}
		tileQueue.push(data);
		if (tileQueue.length >= TILE_BACKLOG && !pausedSocket) {
			pausedSocket = socket;
			socket.pause();
		}
		void drainTiles();
	}

	async function drainTiles() {
		if (tileBusy) {
			return;
		}
		tileBusy = true;
		try {
			while (tileQueue.length > 0) {
				const data = tileQueue.shift();
				try {
					await ingestTile(data);
				} catch (error) {
					const broken = error.message === "无法识别地图图块" || error.message === "图块不是 WebP" || error.message === "图块像素不对";
					console.error(`${broken ? "地图图块无法解析" : "地图图块保存失败"}：${error.message}`);
				}
				if (pausedSocket && tileQueue.length < TILE_BACKLOG / 2) {
					resumeTiles();
				}
			}
		} finally {
			tileBusy = false;
			resumeTiles();
		}
	}

	function resumeTiles() {
		if (!pausedSocket) {
			return;
		}
		const socket = pausedSocket;
		pausedSocket = null;
		if (socket.readyState === 1) {
			socket.resume();
		}
	}

	function onMessage(data, isBinary) {
		try {
			if (isBinary) {
				const frame = decodeFrame(data);
				const body = frame.json ? JSON.parse(frame.body.toString("utf8")) : frame.body;
				settle(frame.id, { status: frame.status, body });
				return;
			}
			const message = JSON.parse(Buffer.from(data).toString("utf8"));
			if (message.op !== "res" || typeof message.id !== "string") {
				return;
			}
			settle(message.id, { status: Number(message.status) || 500, body: message.body ?? {} });
		} catch (error) {
			console.error(`模组回传无法解析：${error.message}`);
		}
	}

	function detachRole(role, message) {
		const target = roles[role];
		if (!target) {
			return;
		}
		if (target.beat) {
			clearInterval(target.beat);
			target.beat = null;
		}
		target.socket = null;
		if (role === "command") {
			commandReady = false;
			failAll(message);
		}
	}

	function attach(socket, role = "command") {
		const target = roles[role] ? roles[role] : roles.command;
		const name = target === roles.map ? "map" : "command";
		const previous = target.socket;
		if (target.beat) {
			clearInterval(target.beat);
			target.beat = null;
		}
		if (previous && previous !== socket) {
			target.socket = null;
			previous.close();
		}
		if (name === "command") {
			commandReady = false;
			if (previous) {
				failAll("模组重新连接");
			}
		}
		target.socket = socket;
		let seenPong = true;
		target.beat = setInterval(() => {
			if (target.socket !== socket || socket.readyState !== 1) {
				return;
			}
			if (!seenPong) {
				socket.terminate();
				return;
			}
			seenPong = false;
			try {
				socket.ping();
			} catch {
				socket.terminate();
			}
		}, 15000);
		target.beat.unref?.();
		socket.on("message", (data, isBinary) => {
			if (name === "map") {
				onMapMessage(socket, data, isBinary);
				return;
			}
			onMessage(data, isBinary);
		});
		socket.on("pong", () => {
			seenPong = true;
		});
		socket.on("close", () => {
			if (target.socket === socket) {
				detachRole(name, name === "map" ? "地图连接已断开" : "模组连接已断开");
				console.log(name === "map" ? "地图连接已断开" : "模组连接已断开");
			}
		});
		socket.on("error", (error) => {
			console.error(`${name === "map" ? "地图" : "模组"}连接异常：${error.message}`);
		});
	}

	function markReady(socket) {
		if (roles.command.socket !== socket || socket.readyState !== 1) {
			return;
		}
		commandReady = true;
		sawCommand = true;
		for (const wake of connectWaiters.splice(0)) {
			wake();
		}
	}

	async function request(method, pathname, rawBody = "", options = {}) {
		if (!connected()) {
			const arrived = await whenConnected(options.connectTimeout ?? 10_000);
			if (!arrived || !connected()) {
				const error = new Error("模组未连接");
				error.status = 503;
				throw error;
			}
		}
		const socket = roles.command.socket;
		const id = String(++nextId);
		const queryAt = pathname.indexOf("?");
		const path = queryAt < 0 ? pathname : pathname.slice(0, queryAt);
		const query = queryAt < 0 ? "" : pathname.slice(queryAt + 1);
		const payload = JSON.stringify({
			id,
			op: "req",
			method,
			path,
			query,
			body: rawBody,
		});
		const timeout = options.timeout ?? 30_000;
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				waiters.delete(id);
				const error = new Error("模组没有及时响应");
				error.status = 504;
				reject(error);
			}, timeout);
			timer.unref?.();
			waiters.set(id, { resolve, reject, timer });
			socket.send(payload, (error) => {
				if (!error) {
					return;
				}
				clearTimeout(timer);
				waiters.delete(id);
				const wrapped = new Error("模组连接已断开");
				wrapped.status = 503;
				reject(wrapped);
			});
		});
	}

	function needTiles(tiles) {
		const socket = roles.map.socket;
		if (socket?.readyState !== 1 || !Array.isArray(tiles) || tiles.length === 0) {
			return false;
		}
		socket.send(JSON.stringify({ op: "need", tiles }));
		return true;
	}

	function setTileHandler(handler) {
		tileHandler = handler;
	}

	return { attach, markReady, connected, commandSeen, mapConnected, request, needTiles, setTileHandler, ingestTile };
}

export function acceptBridgeSocket(socket, token, link, log = console) {
	let authed = false;
	const timer = setTimeout(() => {
		if (!authed) {
			socket.close(1008, "未授权");
		}
	}, 5000);
	timer.unref?.();

	// 没登录的连接也可能发坏帧；ws 会发 error 事件，没人接就会让整个服务退出。
	function beforeAuthError() {
		socket.terminate();
	}
	socket.on("error", beforeAuthError);

	function welcome(data, isBinary) {
		if (isBinary) {
			socket.close(1008, "未授权");
			return;
		}
		let message;
		try {
			message = JSON.parse(Buffer.from(data).toString("utf8"));
		} catch {
			socket.close(1008, "未授权");
			return;
		}
		if (message.op !== "auth" || !bridgeTokenOk(typeof message.token === "string" ? message.token : "", token)) {
			log.error?.("模组连接被拒绝");
			socket.close(1008, "未授权");
			return;
		}
		authed = true;
		clearTimeout(timer);
		socket.off("message", welcome);
		socket.off("error", beforeAuthError);
		const role = message.role === "map" ? "map" : "command";
		link.attach(socket, role);
		socket.send(JSON.stringify({ op: "auth", ok: true }));
		if (role === "command") {
			link.markReady(socket);
		}
		log.info?.(role === "map" ? "地图已连接" : "模组已连接");
	}

	socket.on("message", welcome);
}
