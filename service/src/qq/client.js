const API = "https://api.bot.qq.com";
const TOKEN_URL = "https://bots.qq.com/app/getAppAccessToken";

export function createQq(config, fetchImpl = fetch) {
	let token = "";
	let expiresAt = 0;

	async function accessToken() {
		if (token && Date.now() < expiresAt) {
			return token;
		}
		const response = await fetchImpl(TOKEN_URL, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ appId: config.appId, clientSecret: config.appSecret }),
		});
		const data = await response.json();
		if (!response.ok || !data.access_token) {
			throw new Error(data.message || data.msg || "获取 Access Token 失败");
		}
		token = data.access_token;
		const seconds = Number(data.expires_in || 7200);
		expiresAt = Date.now() + Math.max(60, seconds - 60) * 1000;
		return token;
	}

	async function api(method, pathname, body) {
		const response = await fetchImpl(`${API}${pathname}`, {
			method,
			headers: {
				Authorization: `QQBot ${await accessToken()}`,
				"Content-Type": "application/json; charset=utf-8",
			},
			body: body === undefined ? undefined : JSON.stringify(body),
		});
		const text = await response.text();
		let data = {};
		if (text) {
			try {
				data = JSON.parse(text);
			} catch {
				data = { message: text };
			}
		}
		if (!response.ok) {
			const error = new Error(data.message || data.msg || `QQ 接口 ${response.status}`);
			error.status = response.status;
			error.code = data.code;
			error.data = data;
			throw error;
		}
		return data;
	}

	return {
		accessToken,
		api,
		async gateway() {
			try {
				return await api("GET", "/gateway/bot");
			} catch {
				return api("GET", "/gateway");
			}
		},
	};
}
