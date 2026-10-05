const OFFICIAL_ID = /^[A-Za-z0-9_]{3,16}$/;
const NICKNAME = /^[\p{Script=Han}A-Za-z0-9_-]{1,16}$/u;

export function parseRegistration(raw) {
	let text = String(raw || "").trim().replace(/^登记\s+/, "");
	const parts = text.split(/\s+/).filter(Boolean);
	if (parts.length < 2) return null;
	const officialId = parts[0];
	const nickname = parts.slice(1).join("");
	if (parts.length > 2) return null;
	if (!OFFICIAL_ID.test(officialId) || !NICKNAME.test(nickname)) return null;
	return { officialId, nickname };
}

export function prefixLabel(nickname) {
	return `[${nickname}]`;
}
