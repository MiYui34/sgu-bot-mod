import { Worker } from "node:worker_threads";
import { renderTile } from "./render.js";

// 只留一个绘制进程，另一颗核心留给网页请求，避免拖动地图时整页卡住。
const SIZE = 1;
const workers = [];
const queue = [];
let nextId = 1;
let failed = false;
let crashes = 0;

function inline(job) {
	return renderTile(job).then((result) => ({ painted: Boolean(result.body), body: result.body }));
}

function spawn() {
	const worker = new Worker(new URL("./paint-worker.js", import.meta.url));
	worker.unref();
	worker.idle = true;
	worker.current = null;
	worker.retired = false;
	worker.on("message", (message) => finish(worker, message));
	worker.on("error", (error) => {
		console.error(`地图绘制进程异常：${error.message}`);
		fail(worker, error);
	});
	worker.on("exit", () => {
		if (worker.retired) {
			return;
		}
		fail(worker, new Error("绘制进程已退出"));
	});
	return worker;
}

function fail(worker, error) {
	if (worker.retired) {
		return;
	}
	worker.retired = true;
	crashes += 1;
	const current = worker.current;
	worker.current = null;
	const index = workers.indexOf(worker);
	if (index >= 0) {
		workers.splice(index, 1);
	}
	if (crashes >= 3) {
		failed = true;
		console.error("地图改为在当前进程里绘制");
		if (current) {
			current.reject(error);
		}
		while (queue.length > 0) {
			queue.shift().reject(error);
		}
		return;
	}
	if (current) {
		current.reject(error);
	}
	workers.push(spawn());
	pump();
}

function finish(worker, message) {
	const current = worker.current;
	worker.current = null;
	worker.idle = true;
	if (current) {
		crashes = 0;
		if (message.error) {
			current.reject(new Error(message.error));
		} else {
			current.resolve({ painted: message.painted, body: message.body });
		}
	}
	pump();
}

function pump() {
	for (const worker of workers) {
		if (!worker.idle || queue.length === 0) {
			continue;
		}
		const item = queue.shift();
		worker.idle = false;
		worker.current = item;
		worker.postMessage(item.message);
	}
}

export function renderInPool(job) {
	if (failed) {
		return inline(job);
	}
	if (workers.length === 0) {
		try {
			for (let index = 0; index < SIZE; index++) {
				workers.push(spawn());
			}
		} catch (error) {
			failed = true;
			console.error(`地图绘制进程没有启动：${error.message}`);
			return inline(job);
		}
	}
	return new Promise((resolve, reject) => {
		const id = nextId;
		nextId += 1;
		queue.push({ resolve, reject, message: { ...job, id } });
		pump();
	});
}
