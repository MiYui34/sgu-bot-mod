import assert from "node:assert/strict";
import test from "node:test";
import { isDuplicateSequence, sendIncreasing } from "../src/qq/msg-seq.js";

test("去重错误会改用下一个序号", async () => {
	const sequences = new Map();
	const sent = [];
	const used = new Error("消息被去重，请检查请求msgseq");
	used.code = 40054005;
	const seq = await sendIncreasing(sequences, "msg-1", async (next) => {
		sent.push(next);
		if (next === 1) {
			throw used;
		}
	});
	assert.equal(seq, 2);
	assert.deepEqual(sent, [1, 2]);
	assert.equal(sequences.get("msg-1"), 2);
});

test("其他发送错误不会改序号重试", async () => {
	const sequences = new Map();
	await assert.rejects(
		sendIncreasing(sequences, "msg-2", async () => {
			throw new Error("机器人已下线");
		}),
		/机器人已下线/,
	);
	assert.equal(sequences.get("msg-2"), 1);
	assert.equal(isDuplicateSequence({ message: "消息被去重，请检查请求msgseq" }), true);
	assert.equal(isDuplicateSequence({ message: "机器人已下线" }), false);
});
