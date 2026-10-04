import { createWriteStream } from "node:fs";
import { mkdir, rename, rm, stat, utimes } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

const DIRS = {
	overworld: ["dimensions", "minecraft", "overworld", "region"],
	nether: ["dimensions", "minecraft", "the_nether", "region"],
	end: ["dimensions", "minecraft", "the_end", "region"],
};

const NAME = /^r\.-?\d+\.-?\d+\.mca$/;

export async function syncRegions(bridge, worldPath) {
	const listed = await bridge.regions();
	const files = Array.isArray(listed.files) ? listed.files : [];
	const changed = [];
	let bytes = 0;
	let started = false;
	for (const file of files) {
		if (!DIRS[file.dim] || !NAME.test(file.name) || !Number.isSafeInteger(file.size) || file.size < 8192) {
			continue;
		}
		const dest = path.join(worldPath, ...DIRS[file.dim], file.name);
		const current = await stat(dest).catch(() => null);
		if (current && current.size === file.size && Math.abs(current.mtimeMs - Number(file.mtime)) < 2000) {
			continue;
		}
		if (!started) {
			started = true;
			console.log("开始同步区域文件");
		}
		await mkdir(path.dirname(dest), { recursive: true });
		const temporary = `${dest}.${process.pid}.part`;
		try {
			const response = await bridge.openRegion(file.dim, file.name);
			await pipeline(Readable.fromWeb(response.body), createWriteStream(temporary));
			const written = await stat(temporary);
			if (written.size !== file.size) {
				await rm(temporary, { force: true });
				continue;
			}
			await replaceFile(temporary, dest);
			const when = new Date(Number(file.mtime));
			await utimes(dest, when, when);
			changed.push({ dim: file.dim, name: file.name });
			bytes += written.size;
		} catch (error) {
			await rm(temporary, { force: true });
			console.error(`区域文件 ${file.dim}/${file.name} 同步失败：${error.message}`);
		}
	}
	return { updated: changed.length, bytes, files: changed };
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
