import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

const absentUntil = new Map();

export function preloadLockPath(dataDir) {
	return path.join(dataDir, "preload.lock");
}

function pidAlive(pid) {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

export async function preloadActive(file) {
	const until = absentUntil.get(file) || 0;
	if (Date.now() < until) {
		return false;
	}
	let saved;
	try {
		saved = JSON.parse(await readFile(file, "utf8"));
	} catch {
		absentUntil.set(file, Date.now() + 1000);
		return false;
	}
	absentUntil.delete(file);
	const pid = Number(saved.pid);
	if (pid && pidAlive(pid)) {
		return true;
	}
	await rm(file, { force: true });
	return false;
}

export async function acquirePreloadLock(file) {
	absentUntil.delete(file);
	if (await preloadActive(file)) {
		throw new Error("已经有一个全量加载在跑");
	}
	await mkdir(path.dirname(file), { recursive: true });
	await writeFile(file, JSON.stringify({ pid: process.pid, started: Date.now() }));
	absentUntil.delete(file);
}

export async function releasePreloadLock(file) {
	let saved;
	try {
		saved = JSON.parse(await readFile(file, "utf8"));
	} catch {
		return;
	}
	if (Number(saved.pid) !== process.pid) {
		return;
	}
	await rm(file, { force: true });
	absentUntil.delete(file);
}
