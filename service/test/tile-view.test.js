import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const html = readFileSync(new URL("../src/web/index.html", import.meta.url), "utf8");
const match = html.match(/\/\/ tile-sources\r?\n([\s\S]*?)\r?\n\t\t\/\/ end-tile-sources/);
const tileSources = new Function(`"use strict";\n${match[1]}\nreturn tileSources;`)();

const full = (tx, ty) => ({ tx, ty, sx: 0, sy: 0, sw: 256, sh: 256, dx: 0, dy: 0, dw: 256, dh: 256 });

test("缩放不另取图块，仍然整张使用已经画好的地形", () => {
	assert.deepEqual(tileSources({ x: 3, y: -2, z: 0 }), [full(3, -2)]);
	assert.deepEqual(tileSources({ x: 5, y: 1, z: 2 }), [full(5, 1)]);
	assert.deepEqual(tileSources({ x: -1, y: 4, z: -1 }), [full(-1, 4)]);
});

test("缩放过远时图块层仍显示 0 级地形", () => {
	assert.match(html, /zoomAnimationThreshold:\s*zoomRange\.max - zoomRange\.min/);
	assert.match(html, /minZoom:\s*zoomRange\.min,\s*maxZoom:\s*zoomRange\.max,\s*minNativeZoom:\s*0,\s*maxNativeZoom:\s*0/);
});
