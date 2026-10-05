const DIMS = {
	overworld: true,
	nether: true,
	end: true,
};

export function bridgeSocketUrl(input) {
	const raw = String(input || "").trim();
	if (!raw) {
		return "";
	}
	let url;
	try {
		url = new URL(raw);
	} catch {
		return "";
	}
	if (url.protocol === "https:") {
		url.protocol = "wss:";
	} else if (url.protocol === "http:") {
		url.protocol = "ws:";
	} else if (url.protocol !== "wss:" && url.protocol !== "ws:") {
		return "";
	}
	if (url.pathname === "/" || url.pathname === "") {
		url.pathname = "/bridge";
	}
	return url.toString();
}

export function parseRegion(name) {
	const match = /^r\.(-?\d+)\.(-?\d+)\.mca$/.exec(name);
	if (!match) {
		return null;
	}
	return { regionX: Number(match[1]), regionZ: Number(match[2]) };
}

export function tilesForRegion(dim, regionX, regionZ) {
	const tileX0 = regionX * 2;
	const tileZ0 = regionZ * 2;
	const tiles = [];
	for (let dz = 0; dz < 2; dz++) {
		for (let dx = 0; dx < 2; dx++) {
			tiles.push({ dim, tileX: tileX0 + dx, tileZ: tileZ0 + dz });
		}
	}
	return tiles;
}

export function tileKey(tile) {
	return `${tile.dim}/${tile.tileX}/${tile.tileZ}`;
}

export function sameStamp(saved, size, mtime) {
	return Boolean(saved) && saved.size === size && saved.mtime === mtime;
}

export function chunksForTile(tileX, tileZ) {
	const chunks = [];
	const chunkX0 = tileX * 16;
	const chunkZ0 = tileZ * 16;
	for (let dz = 0; dz < 16; dz++) {
		for (let dx = 0; dx < 16; dx++) {
			chunks.push({ chunkX: chunkX0 + dx, chunkZ: chunkZ0 + dz });
		}
	}
	return chunks;
}

export function acceptNeed(message) {
	if (!message || message.op !== "need" || !Array.isArray(message.tiles)) {
		return [];
	}
	const tiles = [];
	for (const tile of message.tiles) {
		const dim = tile?.dim;
		const tileX = Number(tile?.x);
		const tileZ = Number(tile?.z);
		if (!DIMS[dim] || !Number.isInteger(tileX) || !Number.isInteger(tileZ)) {
			continue;
		}
		if (Math.abs(tileX) > 1_000_000 || Math.abs(tileZ) > 1_000_000) {
			continue;
		}
		tiles.push({ dim, tileX, tileZ });
	}
	return tiles;
}

export function pullNext(queue) {
	const index = queue.findIndex((item) => item.urgent);
	const chosen = index >= 0 ? index : 0;
	return queue.splice(chosen, 1)[0];
}

export function createSendLimiter(bytesPerSecond, now = Date.now) {
	let tokens = bytesPerSecond;
	let last = now();
	return function waitFor(size, urgent) {
		const current = now();
		const elapsed = Math.max(0, current - last);
		last = current;
		tokens = Math.min(bytesPerSecond, tokens + (elapsed / 1000) * bytesPerSecond);
		const cost = Math.max(0, size);
		if (urgent) {
			tokens = Math.max(-bytesPerSecond, tokens - cost);
			return 0;
		}
		if (tokens >= cost) {
			tokens -= cost;
			return 0;
		}
		const wait = ((cost - tokens) / bytesPerSecond) * 1000;
		tokens = 0;
		return wait;
	};
}

export function workerCount(argv = process.argv, fallback = 12) {
	const fromArg = argv.find((item) => item.startsWith("--jobs="));
	if (fromArg) {
		const value = Number(fromArg.slice("--jobs=".length));
		if (value >= 1 && value <= 16) {
			return value;
		}
	}
	return fallback;
}

export function uploadBytesPerSecond(argv = process.argv, env = process.env) {
	const fromArg = argv.find((item) => item.startsWith("--mbps="));
	const raw = fromArg ? Number(fromArg.slice("--mbps=".length)) : Number(env.MAP_UPLOAD_MBPS || 8);
	const mbps = raw >= 1 && raw <= 40 ? raw : 8;
	return Math.round((mbps * 1000 * 1000) / 8);
}
