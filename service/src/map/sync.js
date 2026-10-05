import { randomBytes } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, readdir, rename, rm, stat, utimes } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

const DIRS = {
	overworld: ["dimensions", "minecraft", "overworld", "region"],
	nether: ["dimensions", "minecraft", "the_nether", "region"],
	end: ["dimensions", "minecraft", "the_end", "region"],
};

const NAME = /^r\.-?\d+\.-?\d+\.mca$/;

// 后台同步和打开地图时的按需下载可能同时拉同一个区域，下载中的文件不能共用一个名字。
export function partPath(dest) {
	return `${dest}.${process.pid}.${randomBytes(4).toString("hex")}.part`;
}

export function regionPath(worldPath, dim, name) {
	const parts = DIRS[dim];
	if (!parts || !NAME.test(name)) {
		return "";
	}
	return path.join(worldPath, ...parts, name);
}

export async function syncRegions(bridge, worldPath, options = {}) {
	if (!options.manifest) {
		options.manifest = { files: {} };
	}
	if (!options.manifest.files) {
		options.manifest.files = {};
	}
	const index = options.manifest.files;
	const listed = await bridge.regions();
	const files = Array.isArray(listed.files) ? listed.files : [];
	const world = typeof listed.world === "string" ? listed.world : "";
	const previousWorld = options.previousWorld || "";
	const worldChanged = Boolean(world && previousWorld && world !== previousWorld);
	let released = 0;
	if (worldChanged) {
		for (const key of Object.keys(index)) {
			delete index[key];
		}
		released += await removeLocalRegions(worldPath);
		if (options.onWorldChange) {
			await options.onWorldChange();
		}
	}
	const remote = new Set();
	const accepted = [];
	for (const file of files) {
		if (!DIRS[file.dim] || !NAME.test(file.name) || !Number.isSafeInteger(file.size) || file.size < 8192) {
			continue;
		}
		remote.add(`${file.dim}/${file.name}`);
		accepted.push(file);
	}
	// 模组一时列不出区域（世界还没加载、目录读失败）时返回空表，不能据此把云端整张图删光。
	const listedNothing = accepted.length === 0 && Object.keys(index).length > 0;
	const removed = worldChanged || listedNothing ? { files: [], bytes: 0 } : await removeMissing(worldPath, index, remote);
	released += removed.bytes;
	const changed = [];
	const pending = [];
	let bytes = 0;
	for (const file of accepted) {
		const key = `${file.dim}/${file.name}`;
		const dest = path.join(worldPath, ...DIRS[file.dim], file.name);
		const entry = index[key];
		const local = await stat(dest).catch(() => null);
		if (entry && !entry.pending && sameFile(entry.size, entry.mtime, file)) {
			if (local && !(await painted(options, file))) {
				continue;
			}
			released += await removeFile(dest);
			continue;
		}
		if (!entry && local && sameFile(local.size, local.mtimeMs, file)) {
			if (!(await painted(options, file))) {
				continue;
			}
			index[key] = { size: file.size, mtime: Number(file.mtime) };
			released += await removeFile(dest);
			continue;
		}
		pending.push({ file, dest, key, local });
	}
	let started = false;
	await runLimited(pending, 3, async (item) => {
		const { file, dest, key } = item;
		while (options.yieldToPriority?.()) {
			await delay(300);
		}
		let local = await stat(dest).catch(() => null);
		if (!local || !sameFile(local.size, local.mtimeMs, file)) {
			if (!started) {
				started = true;
				console.log("开始同步区域文件");
			}
			const written = await download(bridge, file, dest);
			if (!written) {
				return;
			}
			changed.push({ dim: file.dim, name: file.name });
			bytes += written;
			local = await stat(dest).catch(() => null);
		}
		if (!local) {
			return;
		}
		try {
			if (options.onRegion) {
				await options.onRegion({ dim: file.dim, name: file.name });
			}
		} catch (error) {
			index[key] = { size: file.size, mtime: Number(file.mtime), pending: true };
			throw error;
		}
		index[key] = { size: file.size, mtime: Number(file.mtime) };
		if (options.discard) {
			released += await removeFile(dest);
		}
	});
	return {
		updated: changed.length,
		bytes,
		released,
		files: changed,
		removed: removed.files,
		world,
		worldChanged,
	};
}

async function painted(options, file) {
	if (!options.tilesReady) {
		return true;
	}
	return options.tilesReady(file.dim, file.name);
}

function delay(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

async function runLimited(items, limit, worker) {
	if (items.length === 0) {
		return;
	}
	let index = 0;
	let firstError;
	async function next() {
		while (index < items.length && !firstError) {
			const current = index;
			index += 1;
			try {
				await worker(items[current]);
			} catch (error) {
				firstError = error;
			}
		}
	}
	const width = Math.min(limit, items.length);
	await Promise.all(Array.from({ length: width }, () => next()));
	if (firstError) {
		throw firstError;
	}
}

function sameFile(size, mtime, file) {
	return size === file.size && Math.abs(Number(mtime) - Number(file.mtime)) < 2000;
}

async function download(bridge, file, dest) {
	await mkdir(path.dirname(dest), { recursive: true });
	const temporary = partPath(dest);
	try {
		const response = await bridge.openRegion(file.dim, file.name);
		await pipeline(Readable.fromWeb(response.body), createWriteStream(temporary));
		const written = await stat(temporary);
		if (written.size !== file.size) {
			await rm(temporary, { force: true });
			return 0;
		}
		await replaceFile(temporary, dest);
		const when = new Date(Number(file.mtime));
		await utimes(dest, when, when);
		return written.size;
	} catch (error) {
		await rm(temporary, { force: true });
		console.error(`区域文件 ${file.dim}/${file.name} 同步失败：${error.message}`);
		return 0;
	}
}

async function removeMissing(worldPath, index, remote) {
	const files = [];
	let bytes = 0;
	for (const key of Object.keys(index)) {
		if (remote.has(key)) {
			continue;
		}
		const split = key.indexOf("/");
		files.push({ dim: key.slice(0, split), name: key.slice(split + 1) });
		delete index[key];
	}
	for (const dim of Object.keys(DIRS)) {
		const dir = path.join(worldPath, ...DIRS[dim]);
		let names = [];
		try {
			names = await readdir(dir);
		} catch {
			continue;
		}
		for (const name of names) {
			if (!NAME.test(name) || remote.has(`${dim}/${name}`)) {
				continue;
			}
			bytes += await removeFile(path.join(dir, name));
			if (!files.some((file) => file.dim === dim && file.name === name)) {
				files.push({ dim, name });
			}
		}
	}
	return { files, bytes };
}

async function removeLocalRegions(worldPath) {
	let bytes = 0;
	for (const dim of Object.keys(DIRS)) {
		const dir = path.join(worldPath, ...DIRS[dim]);
		let names = [];
		try {
			names = await readdir(dir);
		} catch {
			continue;
		}
		for (const name of names) {
			if (NAME.test(name)) {
				bytes += await removeFile(path.join(dir, name));
			}
		}
	}
	return bytes;
}

async function removeFile(file) {
	const info = await stat(file).catch(() => null);
	if (!info) {
		return 0;
	}
	await rm(file, { force: true });
	return info.size;
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
