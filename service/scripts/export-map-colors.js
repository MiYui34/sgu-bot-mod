import { writeFileSync } from "node:fs";
import { BLOCK_COLOR } from "../src/map/vanilla-colors.js";
import { MAP_PALETTE } from "../src/map/map-palette.js";

const blocks = ["# name, or name r g b a. A dash means the block is transparent."];
for (const [name, color] of Object.entries(BLOCK_COLOR)) {
	if (!color) {
		blocks.push(`${name}\t-`);
		continue;
	}
	blocks.push(`${name}\t${color[0]}\t${color[1]}\t${color[2]}\t${color[3] ?? 255}`);
}

const rows = ["# four variants, each r g b a, from darkest-step through bright"];
for (const row of MAP_PALETTE) {
	if (!row?.[2]) {
		continue;
	}
	const nums = [];
	for (const color of row) {
		if (!color) {
			nums.push("0", "0", "0", "0");
			continue;
		}
		nums.push(String(color[0]), String(color[1]), String(color[2]), String(color[3] ?? 255));
	}
	rows.push(nums.join("\t"));
}

const root = new URL("../../mod/src/main/resources/", import.meta.url);
writeFileSync(new URL("map-block-colors.tsv", root), `${blocks.join("\n")}\n`);
writeFileSync(new URL("map-palette.tsv", root), `${rows.join("\n")}\n`);
console.log(`blocks ${blocks.length - 1} palette ${rows.length - 1}`);
