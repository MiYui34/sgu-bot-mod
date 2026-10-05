import { panelItems } from "../bot/handle.js";

const REMARK = "sgu-bridge";

export async function ensurePanel(qq, config) {
	const panel = { items: panelItems(), remark: REMARK };
	const list = await qq.api("GET", "/v2/panels?scope=group&limit=50");
	const panels = list.panels || list.data || [];
	const existing = panels.find((item) => item.panel?.remark === REMARK || item.remark === REMARK);
	if (existing?.panel_id) {
		await qq.api("PUT", `/v2/panels/${existing.panel_id}`, { panel });
		return existing.panel_id;
	}
	const body = { scope: "group", target_type: "all", panel };
	if (config.allowedGroups.length > 0 && config.allowedGroups.length <= 20) {
		body.target_type = "specific";
		body.group_openids = config.allowedGroups;
	}
	const created = await qq.api("POST", "/v2/panels", body);
	return created.panel_id;
}
