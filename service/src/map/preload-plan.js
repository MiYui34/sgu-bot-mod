export function sameRemote(entry, file) {
	return Boolean(entry)
		&& !entry.pending
		&& entry.size === file.size
		&& Math.abs(Number(entry.mtime) - Number(file.mtime)) < 2000;
}

// skip：瓦片已是这一版颜色，区域文件也不在了。
// drop：瓦片已画好，把还留着的区域文件删掉。
// paint：要下载并重画。
export function regionAction({ entry, file, tilesReady, epoch, force, localExists }) {
	if (!force && sameRemote(entry, file) && entry.color === epoch && tilesReady) {
		return localExists ? "drop" : "skip";
	}
	return "paint";
}
