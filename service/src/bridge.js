export function createBridge(config, fetchImpl = fetch) {
	async function request(method, pathname, body) {
		const response = await fetchImpl(`${config.bridgeUrl}${pathname}`, {
			method,
			headers: {
				Authorization: `Bearer ${config.bridgeToken}`,
				"Content-Type": "application/json; charset=utf-8",
			},
			body: body === undefined ? undefined : JSON.stringify(body),
		});
		const text = await response.text();
		let data = {};
		try {
			data = text ? JSON.parse(text) : {};
		} catch {
			data = { error: text };
		}
		if (!response.ok) {
			const error = new Error(data.error || `模组接口 ${response.status}`);
			error.status = response.status;
			error.data = data;
			throw error;
		}
		return data;
	}

	async function openRegion(dim, name) {
		const response = await fetchImpl(`${config.bridgeUrl}/v1/regions/${dim}/${encodeURIComponent(name)}`, {
			headers: {
				Authorization: `Bearer ${config.bridgeToken}`,
			},
		});
		if (!response.ok) {
			const error = new Error(`区域文件 ${response.status}`);
			error.status = response.status;
			throw error;
		}
		return response;
	}

	return {
		health: () => request("GET", "/v1/health"),
		fakePlayers: () => request("GET", "/v1/fake-players"),
		online: () => request("GET", "/v1/players/online"),
		lastLogout: (name) => request("GET", `/v1/players/last-logout?name=${encodeURIComponent(name)}`),
		lastDeath: (name) => request("GET", `/v1/players/last-death?name=${encodeURIComponent(name)}`),
		killFake: (name) => request("POST", `/v1/fake-players/${encodeURIComponent(name)}/kill`),
		command: (command) => request("POST", "/v1/commands", { command }),
		regions: () => request("GET", "/v1/regions"),
		openRegion,
	};
}
