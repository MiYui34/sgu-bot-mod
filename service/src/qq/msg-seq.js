export function isDuplicateSequence(error) {
	const code = Number(error?.code ?? error?.data?.err_code ?? error?.data?.code ?? 0);
	if (code === 40054005) {
		return true;
	}
	const message = `${error?.message || ""} ${error?.data?.message || ""}`;
	return message.includes("消息被去重");
}

export async function sendIncreasing(sequences, key, send) {
	let seq = sequences.get(key) || 0;
	let last;
	for (let attempt = 0; attempt < 5; attempt += 1) {
		seq += 1;
		sequences.set(key, seq);
		try {
			await send(seq);
			return seq;
		} catch (error) {
			last = error;
			if (!isDuplicateSequence(error)) {
				throw error;
			}
		}
	}
	throw last;
}
