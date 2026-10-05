import test from "node:test";
import assert from "node:assert/strict";
import { formatLogout } from "../src/bot/handle.js";

test("offline fake player includes summoner and who logged them off", () => {
	const text = formatLogout({
		name: "Alex",
		fake: true,
		kind: "logout",
		dimension: "minecraft:overworld",
		x: 10.2,
		y: 64,
		z: -3,
		time: "2026-10-04T15:00:00+08:00",
		summonerName: "Steve",
		summonedAt: "2026-10-04T14:00:00+08:00",
		actorName: "米悠",
		actorSource: "qq",
	});
	assert.match(text, /Alex/);
	assert.match(text, /最后下线/);
	assert.match(text, /主世界 10 64 -3/);
	assert.match(text, /召唤人：Steve/);
	assert.match(text, /下线人：QQ 米悠/);
});

test("real player self logout and server stop", () => {
	const self = formatLogout({
		name: "Steve",
		fake: false,
		kind: "logout",
		dimension: "minecraft:the_nether",
		x: 1,
		y: 2,
		z: 3,
		time: "2026-10-04T15:00:00+08:00",
		actorSource: "self",
	});
	assert.match(self, /下线人：自行下线/);
	assert.doesNotMatch(self, /召唤人/);

	const stopped = formatLogout({
		name: "Steve",
		fake: false,
		kind: "last_known",
		dimension: "minecraft:overworld",
		x: 0,
		y: 0,
		z: 0,
		time: "2026-10-04T15:00:00+08:00",
		actorSource: "server",
	});
	assert.match(stopped, /最后已知位置/);
	assert.match(stopped, /下线人：服务器关闭/);
});
