import { readFile } from "node:fs/promises";
import encode, { init } from "@jsquash/webp/encode.js";

// 无损。method 0 是最快档，地图这种色块图仍然比 PNG 小，也不会把进程堵住。
const LOSSLESS = {
	lossless: 1,
	quality: 75,
	method: 0,
	exact: 0,
	near_lossless: 100,
	image_hint: 3,
	low_memory: 0,
};

let ready;

function encoder() {
	if (!ready) {
		ready = loadEncoder();
	}
	return ready;
}

async function loadEncoder() {
	const simd = await readFile(new URL(import.meta.resolve("@jsquash/webp/codec/enc/webp_enc_simd.wasm")));
	const binary = WebAssembly.validate(simd)
		? simd
		: await readFile(new URL(import.meta.resolve("@jsquash/webp/codec/enc/webp_enc.wasm")));
	await init({ wasmBinary: binary });
}

export async function encodeLosslessWebp(pixels, width, height) {
	await encoder();
	const encoded = await encode({ data: pixels, width, height }, LOSSLESS);
	return Buffer.from(encoded);
}
