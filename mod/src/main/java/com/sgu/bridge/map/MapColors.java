package com.sgu.bridge.map;

import java.io.BufferedReader;
import java.io.IOException;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.nio.charset.StandardCharsets;
import java.util.HashMap;
import java.util.HashSet;
import java.util.Map;
import java.util.Set;

public final class MapColors {
	private static final int[] MODIFIER = {180, 220, 255, 135};
	private static final String[] DYE_ORDER = {
		"light_blue", "light_gray", "white", "orange", "magenta", "yellow", "lime", "pink",
		"gray", "cyan", "purple", "blue", "brown", "green", "red", "black"
	};
	private static final int[] DYE_RGB = {
		pack(102, 153, 216, 255),
		pack(153, 153, 153, 255),
		pack(255, 255, 255, 255),
		pack(216, 127, 51, 255),
		pack(178, 76, 216, 255),
		pack(229, 229, 51, 255),
		pack(127, 204, 25, 255),
		pack(242, 127, 165, 255),
		pack(76, 76, 76, 255),
		pack(76, 127, 153, 255),
		pack(127, 63, 178, 255),
		pack(51, 76, 178, 255),
		pack(102, 76, 51, 255),
		pack(102, 127, 51, 255),
		pack(153, 51, 51, 255),
		pack(25, 25, 25, 255)
	};

	private static MapColors instance;
	private final Map<String, Integer> blocks;
	private final Set<String> clear;
	private final Map<Integer, int[]> palette;

	private MapColors(Map<String, Integer> blocks, Set<String> clear, Map<Integer, int[]> palette) {
		this.blocks = blocks;
		this.clear = clear;
		this.palette = palette;
	}

	public static MapColors get() throws IOException {
		synchronized (MapColors.class) {
			if (instance == null) {
				instance = load();
			}
			return instance;
		}
	}

	public int base(String name) {
		if (name == null || name.isEmpty()) {
			return 0;
		}
		String id = name.indexOf(':') < 0 ? "minecraft:" + name : name;
		if (isAir(id) || clear.contains(id)) {
			return 0;
		}
		Integer known = blocks.get(id);
		if (known != null) {
			return known;
		}
		return fallback(id);
	}

	public int shade(int argb, int variant) {
		if (argb == 0) {
			return 0;
		}
		int index = variant >= 0 && variant < 4 ? variant : 1;
		int[] row = palette.get(argb & 0xffffff);
		if (row != null) {
			return row[index];
		}
		int modifier = MODIFIER[index];
		if (modifier == 255) {
			return argb;
		}
		int rgb = argb & 0xffffff;
		int red = (rgb >> 16) & 0xff;
		int green = (rgb >> 8) & 0xff;
		int blue = rgb & 0xff;
		int alpha = (argb >>> 24) & 0xff;
		return pack((red * modifier) / 255, (green * modifier) / 255, (blue * modifier) / 255, alpha);
	}

	private int fallback(String id) {
		String bare = id.substring(id.indexOf(':') + 1);
		if (bare.equals("water") || bare.endsWith("_water") || bare.equals("bubble_column")) {
			return known("minecraft:water", pack(64, 64, 255, 255));
		}
		if (bare.equals("lava") || bare.endsWith("_lava")) {
			return known("minecraft:lava", pack(255, 0, 0, 255));
		}
		if (bare.endsWith("_leaves") || bare.equals("vine")) {
			return known("minecraft:oak_leaves", pack(0, 124, 0, 255));
		}
		if (bare.endsWith("_log") || bare.endsWith("_wood") || bare.endsWith("_hyphae") || bare.endsWith("_stem")) {
			return known("minecraft:oak_log", pack(143, 119, 72, 255));
		}
		if (bare.endsWith("_ore")) {
			return known("minecraft:stone", pack(112, 112, 112, 255));
		}
		for (int i = 0; i < DYE_ORDER.length; i++) {
			String dye = DYE_ORDER[i];
			if (bare.equals(dye) || bare.startsWith(dye + "_")) {
				return DYE_RGB[i];
			}
		}
		return known("minecraft:stone", pack(112, 112, 112, 255));
	}

	private int known(String id, int fallback) {
		Integer value = blocks.get(id);
		return value == null ? fallback : value;
	}

	private static boolean isAir(String id) {
		return id.equals("minecraft:air")
			|| id.equals("minecraft:cave_air")
			|| id.equals("minecraft:void_air")
			|| id.equals("minecraft:light")
			|| id.equals("minecraft:structure_void");
	}

	private static MapColors load() throws IOException {
		Map<String, Integer> blocks = new HashMap<>(2048);
		Set<String> clear = new HashSet<>(256);
		for (String line : lines("map-block-colors.tsv")) {
			String[] parts = line.split("\t");
			if (parts.length == 2 && "-".equals(parts[1])) {
				clear.add(parts[0]);
				continue;
			}
			if (parts.length != 5) {
				continue;
			}
			int packed = pack(parseChannel(parts[1]), parseChannel(parts[2]), parseChannel(parts[3]), parseChannel(parts[4]));
			if (packed == 0) {
				clear.add(parts[0]);
			} else {
				blocks.put(parts[0], packed);
			}
		}
		if (blocks.isEmpty()) {
			throw new IOException("地图颜色表是空的");
		}
		Map<Integer, int[]> palette = new HashMap<>(128);
		for (String line : lines("map-palette.tsv")) {
			String[] parts = line.split("\t");
			if (parts.length != 16) {
				continue;
			}
			int[] row = new int[4];
			for (int variant = 0; variant < 4; variant++) {
				int at = variant * 4;
				row[variant] = pack(
					parseChannel(parts[at]),
					parseChannel(parts[at + 1]),
					parseChannel(parts[at + 2]),
					parseChannel(parts[at + 3])
				);
			}
			if (row[2] == 0) {
				continue;
			}
			palette.put(row[2] & 0xffffff, row);
		}
		if (palette.isEmpty()) {
			throw new IOException("地图色阶表是空的");
		}
		return new MapColors(blocks, clear, palette);
	}

	private static int parseChannel(String text) throws IOException {
		try {
			int value = Integer.parseInt(text);
			if (value < 0 || value > 255) {
				throw new IOException("地图颜色超出范围");
			}
			return value;
		} catch (NumberFormatException e) {
			throw new IOException("地图颜色无法读取");
		}
	}

	private static java.util.List<String> lines(String name) throws IOException {
		InputStream input = MapColors.class.getClassLoader().getResourceAsStream(name);
		if (input == null) {
			throw new IOException("缺少 " + name);
		}
		java.util.List<String> lines = new java.util.ArrayList<>();
		try (BufferedReader reader = new BufferedReader(new InputStreamReader(input, StandardCharsets.UTF_8))) {
			String line;
			while ((line = reader.readLine()) != null) {
				if (line.isBlank() || line.charAt(0) == '#') {
					continue;
				}
				lines.add(line);
			}
		}
		return lines;
	}

	static int pack(int red, int green, int blue, int alpha) {
		if (alpha <= 0) {
			return 0;
		}
		return (alpha << 24) | (red << 16) | (green << 8) | blue;
	}
}
