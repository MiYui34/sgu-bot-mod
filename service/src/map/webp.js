import { readFile } from "node:fs/promises";
import encode, { init } from "@jsquash/webp/encode.js";

// 无损、method 0。地图色块用这一档编码最快，打开页面时不会被压缩拖住。
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

export async function encodeLosslessWebp(pixels, width, height, method = 0) {
	await encoder();
	const encoded = await encode({ data: pixels, width, height }, { ...LOSSLESS, method });
	return Buffer.from(encoded);
}
