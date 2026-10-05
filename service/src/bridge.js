export function createBridge(config, fetchImpl = fetch, link = null) {
	async function forward(method, pathname, rawBody = "", options = {}) {
		if (link?.connected() || link?.commandSeen?.()) {
			try {
				return await link.request(method, pathname, rawBody, options);
			} catch (error) {
				const dropped = error.message === "模组连接已断开" || error.message === "模组重新连接";
				if (method === "GET" && dropped && !options.retried) {
					return forward(method, pathname, rawBody, { ...options, retried: true });
				}
				if (error.message !== "模组未连接") {
					throw error;
				}
			}
		}
		try {
			const headers = {
				Authorization: `Bearer ${config.bridgeToken}`,
			};
			const binary = Boolean(options.binary);
			if (!binary) {
				headers["Content-Type"] = "application/json; charset=utf-8";
			}
			const response = await fetchImpl(`${config.bridgeUrl}${pathname}`, {
				method,
				headers,
				body: method === "GET" || method === "HEAD" || rawBody === "" ? undefined : rawBody,
			});
			if (binary) {
				return { status: response.status, body: Buffer.from(await response.arrayBuffer()) };
			}
			const text = await response.text();
			let data = {};
			try {
				data = text ? JSON.parse(text) : {};
			} catch {
				data = { error: text };
			}
			return { status: response.status, body: data };
		} catch (error) {
			if (link) {
				const wrapped = new Error("模组未连接");
				wrapped.status = 503;
				throw wrapped;
			}
			throw error;
		}
	}

	async function request(method, pathname, body) {
		const raw = body === undefined ? "" : JSON.stringify(body);
		const result = await forward(method, pathname, raw, { timeout: pathname === "/v1/commands" ? 30_000 : 15_000 });
		if (result.status < 200 || result.status >= 300) {
			const error = new Error(result.body?.error || `模组接口 ${result.status}`);
			error.status = result.status;
			error.data = result.body;
			throw error;
		}
		return result.body;
	}

	async function openRegion(dim, name) {
		const result = await forward("GET", `/v1/regions/${dim}/${encodeURIComponent(name)}`, "", { binary: true, timeout: 120_000 });
		if (result.status !== 200) {
			const error = new Error(`区域文件 ${result.status}`);
			error.status = result.status;
			throw error;
		}
		return new Response(result.body);
	}

	return {
		health: () => request("GET", "/v1/health"),
		fakePlayers: () => request("GET", "/v1/fake-players"),
		online: () => request("GET", "/v1/players/online"),
		lastLogout: (name) => request("GET", `/v1/players/last-logout?name=${encodeURIComponent(name)}`),
		lastDeath: (name) => request("GET", `/v1/players/last-death?name=${encodeURIComponent(name)}`),
		killFake: (name, actor) => request("POST", `/v1/fake-players/${encodeURIComponent(name)}/kill`, { actor: actor || "" }),
		command: (command) => request("POST", "/v1/commands", { command }),
		setPrefix: (body) => request("POST", "/v1/name-prefix", body),
		regions: () => request("GET", "/v1/regions"),
		openRegion,
		forward,
	};
}
