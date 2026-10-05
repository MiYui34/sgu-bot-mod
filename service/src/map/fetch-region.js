import { mkdir, rename, rm, stat, utimes, writeFile } from "node:fs/promises";
import { partPath, regionPath } from "./sync.js";

const LIMIT = 3;
const ABSENT_MS = 10 * 60 * 1000;

let priority = 0;
let active = 0;
const waiting = [];
const inflight = new Map();
const absent = new Map();
let catalog = null;
let catalogAt = 0;

export function priorityPending() {
	return priority > 0;
}

export function createRegionFetcher(bridge, worldPath) {
	return function ensureRegion(dim, name) {
		const dest = regionPath(worldPath, dim, name);
		if (!dest) {
			return "absent";
		}
		const key = `${dim}/${name}`;
		const current = inflight.get(key);
		if (current) {
			return current;
		}
		priority += 1;
		const job = run(() => pull(bridge, dest, dim, name, key))
			.finally(() => {
				priority -= 1;
				inflight.delete(key);
			});
		inflight.set(key, job);
		return job;
	};
}

async function pull(bridge, dest, dim, name, key) {
	const until = absent.get(key) || 0;
	if (until > Date.now()) {
		return "absent";
	}
	const existing = await stat(dest).catch(() => null);
	if (existing && existing.size >= 8192) {
		return "ready";
	}
	let listed;
	try {
		listed = await regionRecord(bridge, dim, name);
	} catch {
		return "failed";
	}
	if (!listed) {
		absent.set(key, Date.now() + ABSENT_MS);
		return "absent";
	}
	const temporary = partPath(dest);
	try {
		const result = await bridge.forward("GET", `/v1/regions/${dim}/${encodeURIComponent(name)}`, "", {
			binary: true,
			timeout: 120_000,
		});
		if (result.status === 404) {
			absent.set(key, Date.now() + ABSENT_MS);
			return "absent";
		}
		if (result.status !== 200 || !Buffer.isBuffer(result.body) || result.body.length < 8192) {
			return "failed";
		}
		await mkdir(parentDir(dest), { recursive: true });
		await writeFile(temporary, result.body);
		const written = await stat(temporary);
		if (written.size !== result.body.length) {
			await rm(temporary, { force: true });
			return "failed";
		}
		await replaceFile(temporary, dest);
		const when = new Date(Number(listed.mtime) || Date.now());
		await utimes(dest, when, when);
		return "ready";
	} catch {
		await rm(temporary, { force: true });
		return "failed";
	}
}

function parentDir(file) {
	const slash = Math.max(file.lastIndexOf("/"), file.lastIndexOf("\\"));
	return slash < 0 ? "." : file.slice(0, slash);
}

async function regionRecord(bridge, dim, name) {
	if (!catalog || Date.now() - catalogAt > 60_000) {
		const listed = await bridge.regions();
		catalog = new Map();
		for (const file of Array.isArray(listed.files) ? listed.files : []) {
			catalog.set(`${file.dim}/${file.name}`, file);
		}
		catalogAt = Date.now();
	}
	return catalog.get(`${dim}/${name}`) || null;
}

function run(work) {
	return new Promise((resolve, reject) => {
		const start = () => {
			active += 1;
			work().then(resolve, reject).finally(() => {
				active -= 1;
				const next = waiting.shift();
				if (next) {
					next();
				}
			});
		};
		if (active < LIMIT) {
			start();
		} else {
			waiting.push(start);
		}
	});
}

async function replaceFile(temporary, dest) {
	try {
		await rename(temporary, dest);
	} catch (error) {
		if (error.code !== "EPERM" && error.code !== "EEXIST") {
			throw error;
		}
		await rm(dest, { force: true });
		await rename(temporary, dest);
	}
}
