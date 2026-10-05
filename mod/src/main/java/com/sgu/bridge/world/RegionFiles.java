package com.sgu.bridge.world;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.regex.Pattern;
import java.util.stream.Stream;

public final class RegionFiles {
	public record Listed(String dim, String name, long size, long mtime) {
	}

	private static final Pattern NAME = Pattern.compile("r\\.-?\\d+\\.-?\\d+\\.mca");

	private RegionFiles() {
	}

	public static List<Listed> list(Path worldRoot) throws IOException {
		List<Listed> files = new ArrayList<>();
		collect(files, "overworld", choose(
			worldRoot.resolve("region"),
			worldRoot.resolve("dimensions").resolve("minecraft").resolve("overworld").resolve("region")
		));
		collect(files, "nether", choose(
			worldRoot.resolve("dimensions").resolve("minecraft").resolve("the_nether").resolve("region"),
			worldRoot.resolve("DIM-1").resolve("region")
		));
		collect(files, "end", choose(
			worldRoot.resolve("dimensions").resolve("minecraft").resolve("the_end").resolve("region"),
			worldRoot.resolve("DIM1").resolve("region")
		));
		return files;
	}

	public static Path resolve(Path worldRoot, String dim, String name) throws IOException {
		if (!NAME.matcher(name).matches()) {
			throw new IOException("文件名无效");
		}
		Path directory = switch (dim) {
			case "overworld" -> choose(
				worldRoot.resolve("region"),
				worldRoot.resolve("dimensions").resolve("minecraft").resolve("overworld").resolve("region")
			);
			case "nether" -> choose(
				worldRoot.resolve("dimensions").resolve("minecraft").resolve("the_nether").resolve("region"),
				worldRoot.resolve("DIM-1").resolve("region")
			);
			case "end" -> choose(
				worldRoot.resolve("dimensions").resolve("minecraft").resolve("the_end").resolve("region"),
				worldRoot.resolve("DIM1").resolve("region")
			);
			default -> null;
		};
		if (directory == null) {
			throw new IOException("文件不存在");
		}
		Path file = directory.resolve(name).normalize();
		if (!file.startsWith(directory.normalize()) || !Files.isRegularFile(file)) {
			throw new IOException("文件不存在");
		}
		return file;
	}

	private static void collect(List<Listed> files, String dim, Path directory) throws IOException {
		if (directory == null || !Files.isDirectory(directory)) {
			return;
		}
		try (Stream<Path> stream = Files.list(directory)) {
			for (Path path : stream.toList()) {
				String name = path.getFileName().toString();
				if (!NAME.matcher(name).matches() || !Files.isRegularFile(path)) {
					continue;
				}
				long size;
				long mtime;
				try {
					size = Files.size(path);
					mtime = Files.getLastModifiedTime(path).toMillis();
				} catch (IOException e) {
					continue;
				}
				if (size < 8192) {
					continue;
				}
				files.add(new Listed(dim, name, size, mtime));
			}
		}
	}

	private static Path choose(Path primary, Path secondary) throws IOException {
		if (hasRegion(primary)) {
			return primary;
		}
		if (hasRegion(secondary)) {
			return secondary;
		}
		if (Files.isDirectory(primary)) {
			return primary;
		}
		if (Files.isDirectory(secondary)) {
			return secondary;
		}
		return null;
	}

	private static boolean hasRegion(Path directory) throws IOException {
		if (!Files.isDirectory(directory)) {
			return false;
		}
		try (Stream<Path> stream = Files.list(directory)) {
			return stream.anyMatch(path -> path.getFileName().toString().endsWith(".mca"));
		}
	}
}
