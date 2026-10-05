import assert from "node:assert/strict";
import test from "node:test";
import { createHandler } from "../src/bot/handle.js";

test("确认绑定按钮允许点击，身份仍由验证码核对", async () => {
	const handle = createHandler({
		bridge: {},
		config: {},
		auditPath: "",
		access: {
			claim() {
				return { ok: true, sessionId: "abc123" };
			},
		},
	});
	const result = await handle({
		group_openid: "group",
		content: "123456",
		author: { member_openid: "member-1", union_openid: "union-1", id: "user-1", username: "小明" },
	});
	const button = result.keyboard.content.rows[0].buttons[0];
	assert.equal(button.action.type, 1);
	assert.equal(button.action.permission.type, 2);
	assert.deepEqual(button.action.permission.specify_user_ids, []);
	assert.equal(button.action.data, "b:abc123");
});
