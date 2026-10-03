import path from "node:path";
import { fileURLToPath } from "node:url";

export function loadConfig(env = process.env) {
	const groups = (env.ALLOWED_GROUP_OPENIDS || "")
		.split(",")
		.map((item) => item.trim())
		.filter(Boolean);
	return {
		appId: env.APP_ID || "",
		appSecret: env.APP_SECRET || "",
		bridgeUrl: (env.BRIDGE_URL || "http://127.0.0.1:8765").replace(/\/$/, ""),
		bridgeToken: env.BRIDGE_TOKEN || "",
		worldPath: env.WORLD_PATH || "/server/world",
		mapPublicUrl: env.MAP_PUBLIC_URL || "",
		allowedGroups: groups,
		httpPort: Number(env.HTTP_PORT || 8880),
		dataDir: env.DATA_DIR || path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "data"),
	};
}

export function groupAllowed(config, groupOpenid) {
	return config.allowedGroups.length === 0 || config.allowedGroups.includes(groupOpenid);
}

export function isAdmin(role) {
	return role === "admin" || role === "owner";
}
