import { Worker } from "node:worker_threads";

export function createPushPool(size) {
	const workers = [];
	const urgent = [];
	const background = [];
	let nextId = 1;
	let crashes = 0;
	let stopped = false;

	function spawn() {
		const worker = new Worker(new URL("./push-worker.js", import.meta.url));
		worker.unref();
		worker.idle = true;
		worker.current = null;
		worker.retired = false;
		worker.on("message", (message) => finish(worker, message));
		worker.on("error", (error) => {
			console.error(`地图绘制线程异常：${error.message}`);
			fail(worker, error);
		});
		worker.on("exit", () => {
			if (worker.retired) {
				return;
			}
			fail(worker, new Error("绘制线程已退出"));
		});
		return worker;
	}

	function fail(worker, error) {
		if (worker.retired || stopped) {
			return;
		}
		worker.retired = true;
		const current = worker.current;
		worker.current = null;
		const index = workers.indexOf(worker);
		if (index >= 0) {
			workers.splice(index, 1);
		}
		if (current) {
			current.reject(error);
		}
		crashes += 1;
		if (crashes >= 8) {
			console.error("绘制线程连续退出，5 秒后再开");
			setTimeout(() => {
				if (stopped) {
					return;
				}
				crashes = 0;
				workers.push(spawn());
				pump();
			}, 5000).unref?.();
			return;
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
				current.resolve(message.body);
			}
		}
		pump();
	}

	function pump() {
		for (const worker of workers) {
			if (!worker.idle) {
				continue;
			}
			const item = urgent.shift() || background.shift();
			if (!item) {
				return;
			}
			worker.idle = false;
			worker.current = item;
			worker.postMessage(item.message);
		}
	}

	function start() {
		for (let index = 0; index < size; index++) {
			workers.push(spawn());
		}
	}

	function render(job, options = {}) {
		return new Promise((resolve, reject) => {
			const id = nextId;
			nextId += 1;
			const entry = { resolve, reject, message: { ...job, id } };
			if (options.urgent) {
				urgent.push(entry);
			} else {
				background.push(entry);
			}
			pump();
		});
	}

	async function stop() {
		stopped = true;
		const current = workers.splice(0, workers.length);
		urgent.length = 0;
		background.length = 0;
		await Promise.all(current.map((worker) => {
			worker.retired = true;
			return worker.terminate();
		}));
	}

	return { start, render, stop };
}
