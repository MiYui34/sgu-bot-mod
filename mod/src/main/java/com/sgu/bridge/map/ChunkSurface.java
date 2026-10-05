package com.sgu.bridge.map;

import net.minecraft.world.level.chunk.storage.RegionFileVersion;

import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.zip.Deflater;
import java.util.zip.GZIPOutputStream;

// 只读磁盘上的区域文件。调用方必须是后台线程，不能在服务器主线程上跑。
public final class ChunkSurface {
	private static final int TILE = 256;
	private static final short SENTINEL = Short.MIN_VALUE;
	private static final int END = 0;
	private static final int BYTE = 1;
	private static final int SHORT = 2;
	private static final int INT = 3;
	private static final int LONG = 4;
	private static final int FLOAT = 5;
	private static final int DOUBLE = 6;
	private static final int BYTE_ARRAY = 7;
	private static final int STRING = 8;
	private static final int LIST = 9;
	private static final int COMPOUND = 10;
	private static final int INT_ARRAY = 11;
	private static final int LONG_ARRAY = 12;
	private static final ThreadLocal<byte[]> RGBA = ThreadLocal.withInitial(() -> new byte[TILE * TILE * 4]);
	private static final int MAX_CHUNK = 16 * 1024 * 1024;
	private static byte[] blank;

	private ChunkSurface() {
	}

	public static byte[] blankTile() throws IOException {
		synchronized (ChunkSurface.class) {
			if (blank == null) {
				blank = gzip(new byte[TILE * TILE * 4], false);
			}
			return blank;
		}
	}

	public static byte[] gzipTile(byte[] region, Path regionDir, int tileX, int tileZ, int minY, boolean urgent, int[] errors) throws IOException {
		if (region == null || region.length < 8192) {
			throw new IOException("区域文件不完整");
		}
		MapColors colors = MapColors.get();
		byte[] rgba = RGBA.get();
		Arrays.fill(rgba, (byte) 0);
		int[][] bases = new int[256][];
		short[][] heights = new short[256][];
		for (int cz = 0; cz < 16; cz++) {
			for (int cx = 0; cx < 16; cx++) {
				int chunkX = tileX * 16 + cx;
				int chunkZ = tileZ * 16 + cz;
				int regionX = Math.floorDiv(chunkX, 32);
				int regionZ = Math.floorDiv(chunkZ, 32);
				int localX = chunkX - regionX * 32;
				int localZ = chunkZ - regionZ * 32;
				int index = localX + localZ * 32;
				Columns columns;
				try {
					columns = readChunk(region, regionDir, chunkX, chunkZ, index, minY, colors);
				} catch (IOException | RuntimeException e) {
					errors[0]++;
					continue;
				}
				if (columns == null) {
					continue;
				}
				int slot = cz * 16 + cx;
				bases[slot] = columns.base;
				heights[slot] = columns.height;
			}
		}
		blit(rgba, bases, heights, colors);
		return gzip(rgba, urgent);
	}

	private static void blit(byte[] rgba, int[][] bases, short[][] heights, MapColors colors) {
		for (int cz = 0; cz < 16; cz++) {
			for (int cx = 0; cx < 16; cx++) {
				int slot = cz * 16 + cx;
				int[] base = bases[slot];
				if (base == null) {
					continue;
				}
				short[] height = heights[slot];
				short[] north = cz > 0 ? heights[slot - 16] : null;
				int pixelX0 = cx * 16;
				int pixelZ0 = cz * 16;
				for (int z = 0; z < 16; z++) {
					for (int x = 0; x < 16; x++) {
						int index = z * 16 + x;
						if (base[index] == 0) {
							continue;
						}
						short northHeight = SENTINEL;
						if (z == 0) {
							if (north != null) {
								northHeight = north[240 + x];
							}
						} else {
							northHeight = height[index - 16];
						}
						int color = colors.shade(base[index], variant(height[index], northHeight));
						if (color == 0) {
							continue;
						}
						int offset = ((pixelZ0 + z) * TILE + pixelX0 + x) * 4;
						rgba[offset] = (byte) ((color >> 16) & 0xff);
						rgba[offset + 1] = (byte) ((color >> 8) & 0xff);
						rgba[offset + 2] = (byte) (color & 0xff);
						rgba[offset + 3] = (byte) ((color >>> 24) & 0xff);
					}
				}
			}
		}
	}

	private static int variant(short height, short north) {
		if (north == SENTINEL || height == SENTINEL || height == north) {
			return 1;
		}
		if (height > north) {
			return 2;
		}
		if (north - height >= 2) {
			return 3;
		}
		return 0;
	}

	private static Columns readChunk(byte[] region, Path regionDir, int chunkX, int chunkZ, int index, int minY, MapColors colors) throws IOException {
		byte[] nbt = readNbt(region, regionDir, chunkX, chunkZ, index);
		if (nbt == null) {
			return null;
		}
		return parse(nbt, minY, colors);
	}

	private static byte[] readNbt(byte[] region, Path regionDir, int chunkX, int chunkZ, int index) throws IOException {
		if (index < 0 || index > 1023) {
			throw new IOException("区块下标无效");
		}
		int header = index * 4;
		long location = ((region[header] & 0xffL) << 24)
			| ((region[header + 1] & 0xffL) << 16)
			| ((region[header + 2] & 0xffL) << 8)
			| (region[header + 3] & 0xffL);
		if (location == 0) {
			return null;
		}
		long offset = (location >>> 8) * 4096L;
		if (offset < 0 || offset > region.length - 5) {
			throw new IOException("区块超出区域文件");
		}
		int at = (int) offset;
		long length = ((region[at] & 0xffL) << 24)
			| ((region[at + 1] & 0xffL) << 16)
			| ((region[at + 2] & 0xffL) << 8)
			| (region[at + 3] & 0xffL);
		if (length < 1 || length > 4L * 1024 * 1024 || offset + 4 + length > region.length) {
			throw new IOException("区块长度异常");
		}
		int compression = region[at + 4] & 0xff;
		// 超过 1MB 的区块由原版放在同目录的 c.X.Z.mcc 里，区域文件只留一个标记字节。
		if ((compression & 0x80) != 0) {
			if (regionDir == null) {
				throw new IOException("找不到外置区块");
			}
			Path external = regionDir.resolve("c." + chunkX + "." + chunkZ + ".mcc");
			if (!Files.isRegularFile(external)) {
				throw new IOException("找不到外置区块");
			}
			if (Files.size(external) > MAX_CHUNK) {
				throw new IOException("外置区块过大");
			}
			byte[] payload = Files.readAllBytes(external);
			return decompress(compression & 0x7f, payload, 0, payload.length);
		}
		if (length <= 1) {
			throw new IOException("区块长度异常");
		}
		return decompress(compression, region, at + 5, (int) length - 1);
	}

	// 解压交给原版的 RegionFileVersion，和服务器写入时用的是同一套 gzip/deflate/none/lz4。
	private static byte[] decompress(int compression, byte[] data, int offset, int length) throws IOException {
		if (!RegionFileVersion.isValidVersion(compression) || compression == RegionFileVersion.VERSION_CUSTOM.getId()) {
			throw new IOException("不支持的压缩类型 " + compression);
		}
		RegionFileVersion version = RegionFileVersion.fromId(compression);
		try (InputStream in = version.wrap(new ByteArrayInputStream(data, offset, length))) {
			return readLimited(in, MAX_CHUNK);
		}
	}

	private static byte[] readLimited(InputStream in, int max) throws IOException {
		ByteArrayOutputStream out = new ByteArrayOutputStream();
		byte[] buffer = new byte[8192];
		int total = 0;
		int count;
		while ((count = in.read(buffer)) >= 0) {
			total += count;
			if (total > max) {
				throw new IOException("区块解压过大");
			}
			out.write(buffer, 0, count);
		}
		return out.toByteArray();
	}

	private static Columns parse(byte[] nbt, int minY, MapColors colors) throws IOException {
		Nbt cursor = new Nbt(nbt, 0, nbt.length);
		if (cursor.u8() != COMPOUND) {
			throw new IOException("区块根标签不是 compound");
		}
		cursor.utf();
		Found found = new Found();
		readChunkCompound(cursor, found);
		int baseY = found.yPos == null ? minY : found.yPos * 16;
		short[] columns = null;
		Set<Integer> needed = null;
		if (found.heightmap != null) {
			needed = new HashSet<>();
			columns = heightmapColumns(found.heightmap, baseY, needed);
			if (columns == null) {
				needed = null;
			}
		}
		List<Section> sections = new ArrayList<>();
		for (Slice slice : found.slices) {
			Integer y = peekY(nbt, slice);
			if (needed != null && (y == null || !needed.contains(y))) {
				continue;
			}
			Section section = readSection(nbt, slice);
			section.prepare(colors);
			sections.add(section);
		}
		if (columns != null) {
			return fromColumns(sections, columns);
		}
		return fullScan(sections);
	}

	private static Columns fromColumns(List<Section> sections, short[] columns) {
		Map<Integer, Section> byY = new HashMap<>();
		for (Section section : sections) {
			byY.put(section.y, section);
		}
		int[] base = new int[256];
		short[] height = new short[256];
		Arrays.fill(height, SENTINEL);
		for (int index = 0; index < 256; index++) {
			short blockY = columns[index];
			if (blockY == SENTINEL) {
				continue;
			}
			int sectionY = Math.floorDiv(blockY, 16);
			int localY = blockY - sectionY * 16;
			if (localY < 0 || localY > 15) {
				continue;
			}
			Section section = byY.get(sectionY);
			if (section == null) {
				continue;
			}
			int color = section.at(index & 15, localY, index >> 4);
			if (color == 0) {
				continue;
			}
			base[index] = color;
			height[index] = blockY;
		}
		return new Columns(base, height);
	}

	private static Columns fullScan(List<Section> sections) {
		sections.sort((left, right) -> Integer.compare(right.y, left.y));
		int[] base = new int[256];
		short[] height = new short[256];
		Arrays.fill(height, SENTINEL);
		int missing = 256;
		for (Section section : sections) {
			if (missing == 0) {
				break;
			}
			if (section.cached.length == 0) {
				continue;
			}
			if (section.cached.length == 1) {
				int color = section.cached[0];
				if (color == 0) {
					continue;
				}
				short top = (short) (section.y * 16 + 15);
				for (int column = 0; column < 256; column++) {
					if (base[column] != 0) {
						continue;
					}
					base[column] = color;
					height[column] = top;
					missing--;
				}
				continue;
			}
			for (int y = 15; y >= 0 && missing > 0; y--) {
				for (int z = 0; z < 16; z++) {
					for (int x = 0; x < 16; x++) {
						int column = z * 16 + x;
						if (base[column] != 0) {
							continue;
						}
						int color = section.at(x, y, z);
						if (color != 0) {
							base[column] = color;
							height[column] = (short) (section.y * 16 + y);
							missing--;
						}
					}
				}
			}
		}
		return new Columns(base, height);
	}

	private static short[] heightmapColumns(long[] longs, int minY, Set<Integer> sections) {
		int bits = bitsForSamples(longs.length, 256);
		if (bits == 0) {
			return null;
		}
		short[] columns = new short[256];
		Arrays.fill(columns, SENTINEL);
		for (int index = 0; index < 256; index++) {
			int stored = packed(longs, bits, index);
			if (stored <= 0) {
				continue;
			}
			int blockY = stored + minY - 1;
			if (blockY <= Short.MIN_VALUE || blockY > Short.MAX_VALUE) {
				continue;
			}
			columns[index] = (short) blockY;
			sections.add(Math.floorDiv(blockY, 16));
		}
		return columns;
	}

	private static int bitsForSamples(int count, int samples) {
		for (int bits = 1; bits <= 32; bits++) {
			int valuesPerLong = 64 / bits;
			if ((samples + valuesPerLong - 1) / valuesPerLong == count) {
				return bits;
			}
		}
		return 0;
	}

	private static int bitsPerBlock(int paletteLength, int dataLength) {
		if (paletteLength <= 1) {
			return 0;
		}
		int minimum = Math.max(4, 32 - Integer.numberOfLeadingZeros(paletteLength - 1));
		if (longsFor(minimum) == dataLength) {
			return minimum;
		}
		for (int bits = minimum + 1; bits <= 16; bits++) {
			if (longsFor(bits) == dataLength) {
				return bits;
			}
		}
		return minimum;
	}

	private static int longsFor(int bits) {
		int valuesPerLong = 64 / bits;
		return (4096 + valuesPerLong - 1) / valuesPerLong;
	}

	private static int packed(long[] longs, int bits, int index) {
		if (bits <= 0 || bits > 32) {
			return 0;
		}
		int valuesPerLong = 64 / bits;
		int longIndex = index / valuesPerLong;
		int offset = (index - longIndex * valuesPerLong) * bits;
		long value = longIndex >= 0 && longIndex < longs.length ? longs[longIndex] : 0L;
		long mask = (1L << bits) - 1L;
		return (int) ((value >>> offset) & mask);
	}

	private static void readChunkCompound(Nbt cursor, Found found) throws IOException {
		while (true) {
			int tag = cursor.u8();
			if (tag == END) {
				return;
			}
			String name = cursor.utf();
			if (name.equals("yPos") && tag == INT) {
				found.yPos = cursor.i32();
			} else if (name.equals("Level") && tag == COMPOUND) {
				readChunkCompound(cursor, found);
			} else if (name.equals("Heightmaps") && tag == COMPOUND) {
				long[] map = readSurfaceMap(cursor);
				if (map != null) {
					found.heightmap = map;
				}
			} else if ((name.equals("sections") || name.equals("Sections")) && tag == LIST) {
				found.slices = readSectionList(cursor);
			} else {
				cursor.skip(tag);
			}
		}
	}

	private static long[] readSurfaceMap(Nbt cursor) throws IOException {
		long[] surface = null;
		long[] generated = null;
		while (true) {
			int tag = cursor.u8();
			if (tag == END) {
				return surface != null ? surface : generated;
			}
			String name = cursor.utf();
			if (name.equals("WORLD_SURFACE") && tag == LONG_ARRAY) {
				surface = cursor.longs();
			} else if (name.equals("WORLD_SURFACE_WG") && tag == LONG_ARRAY) {
				generated = cursor.longs();
			} else {
				cursor.skip(tag);
			}
		}
	}

	private static List<Slice> readSectionList(Nbt cursor) throws IOException {
		int listType = cursor.u8();
		int length = cursor.i32();
		List<Slice> slices = new ArrayList<>();
		if (listType == END || length <= 0) {
			return slices;
		}
		if (length > 48) {
			throw new IOException("区块段过多");
		}
		for (int index = 0; index < length; index++) {
			if (listType != COMPOUND) {
				cursor.skip(listType);
				continue;
			}
			int start = cursor.offset;
			cursor.skip(COMPOUND);
			slices.add(new Slice(start, cursor.offset));
		}
		return slices;
	}

	private static Integer peekY(byte[] buffer, Slice slice) throws IOException {
		Nbt cursor = new Nbt(buffer, slice.start, slice.end);
		while (cursor.offset < slice.end) {
			int tag = cursor.u8();
			if (tag == END) {
				return null;
			}
			String name = cursor.utf();
			if (name.equals("Y")) {
				return readNumber(cursor, tag);
			}
			cursor.skip(tag);
		}
		return null;
	}

	private static Section readSection(byte[] buffer, Slice slice) throws IOException {
		Nbt cursor = new Nbt(buffer, slice.start, slice.end);
		int y = 0;
		String[] palette = null;
		long[] data = null;
		String[] legacyPalette = null;
		long[] legacyData = null;
		while (cursor.offset < slice.end) {
			int tag = cursor.u8();
			if (tag == END) {
				break;
			}
			String name = cursor.utf();
			if (name.equals("Y")) {
				Integer value = readNumber(cursor, tag);
				if (value != null) {
					y = value;
				}
			} else if ((name.equals("block_states") || name.equals("BlockStates")) && tag == COMPOUND) {
				States states = readBlockStates(cursor);
				palette = states.palette;
				data = states.data;
			} else if (name.equals("Palette") && tag == LIST) {
				legacyPalette = readPalette(cursor);
			} else if (name.equals("BlockStates") && tag == LONG_ARRAY) {
				legacyData = cursor.longs();
			} else {
				cursor.skip(tag);
			}
		}
		if (palette == null && legacyPalette != null) {
			palette = legacyPalette;
			data = legacyData == null ? new long[0] : legacyData;
		}
		if (palette == null) {
			palette = new String[0];
		}
		if (data == null) {
			data = new long[0];
		}
		return new Section(y, palette, data);
	}

	private static States readBlockStates(Nbt cursor) throws IOException {
		String[] palette = new String[0];
		long[] data = new long[0];
		while (true) {
			int tag = cursor.u8();
			if (tag == END) {
				break;
			}
			String name = cursor.utf();
			if ((name.equals("palette") || name.equals("Palette")) && tag == LIST) {
				palette = readPalette(cursor);
			} else if ((name.equals("data") || name.equals("Data")) && tag == LONG_ARRAY) {
				data = cursor.longs();
			} else {
				cursor.skip(tag);
			}
		}
		return new States(palette, data);
	}

	private static String[] readPalette(Nbt cursor) throws IOException {
		int listType = cursor.u8();
		int length = cursor.i32();
		if (listType == END || length <= 0) {
			return new String[0];
		}
		if (length > 4096) {
			throw new IOException("调色板过长");
		}
		String[] palette = new String[length];
		for (int index = 0; index < length; index++) {
			if (listType == STRING) {
				palette[index] = cursor.utf();
				continue;
			}
			if (listType != COMPOUND) {
				cursor.skip(listType);
				palette[index] = "minecraft:air";
				continue;
			}
			String name = "minecraft:air";
			while (true) {
				int tag = cursor.u8();
				if (tag == END) {
					break;
				}
				String key = cursor.utf();
				if (key.equals("Name") && tag == STRING) {
					name = cursor.utf();
				} else {
					cursor.skip(tag);
				}
			}
			palette[index] = name;
		}
		return palette;
	}

	private static Integer readNumber(Nbt cursor, int tag) throws IOException {
		if (tag == BYTE) {
			return cursor.i8();
		}
		if (tag == SHORT) {
			return cursor.i16();
		}
		if (tag == INT) {
			return cursor.i32();
		}
		cursor.skip(tag);
		return null;
	}

	private static byte[] gzip(byte[] raw, boolean urgent) throws IOException {
		ByteArrayOutputStream out = new ByteArrayOutputStream(Math.max(64, raw.length / 6));
		try (TightGzip zip = new TightGzip(out, urgent ? Deflater.BEST_SPEED : Deflater.BEST_COMPRESSION)) {
			zip.write(raw);
		}
		return out.toByteArray();
	}

	private static final class TightGzip extends GZIPOutputStream {
		TightGzip(ByteArrayOutputStream out, int level) throws IOException {
			super(out);
			Deflater previous = def;
			def = new Deflater(level, true);
			previous.end();
		}
	}

	private static final class Columns {
		final int[] base;
		final short[] height;

		Columns(int[] base, short[] height) {
			this.base = base;
			this.height = height;
		}
	}

	private static final class Found {
		Integer yPos;
		long[] heightmap;
		List<Slice> slices = List.of();
	}

	private static final class Slice {
		final int start;
		final int end;

		Slice(int start, int end) {
			this.start = start;
			this.end = end;
		}
	}

	private static final class States {
		final String[] palette;
		final long[] data;

		States(String[] palette, long[] data) {
			this.palette = palette;
			this.data = data;
		}
	}

	private static final class Section {
		final int y;
		final String[] palette;
		final long[] data;
		int[] cached = new int[0];
		int bits;

		Section(int y, String[] palette, long[] data) {
			this.y = y;
			this.palette = palette;
			this.data = data;
		}

		void prepare(MapColors colors) {
			cached = new int[palette.length];
			for (int index = 0; index < palette.length; index++) {
				cached[index] = colors.base(palette[index]);
			}
			if (palette.length > 1) {
				bits = bitsPerBlock(palette.length, data.length);
			}
		}

		int at(int x, int y, int z) {
			if (cached.length == 0) {
				return 0;
			}
			int which = 0;
			if (cached.length > 1) {
				which = packed(data, bits, (y << 8) | (z << 4) | x);
			}
			if (which < 0 || which >= cached.length) {
				return 0;
			}
			return cached[which];
		}
	}

	private static final class Nbt {
		final byte[] data;
		final int limit;
		int offset;

		Nbt(byte[] data, int offset, int limit) {
			this.data = data;
			this.offset = offset;
			this.limit = limit;
		}

		int u8() throws IOException {
			need(1);
			return data[offset++] & 0xff;
		}

		int i8() throws IOException {
			need(1);
			return data[offset++];
		}

		int i16() throws IOException {
			need(2);
			int value = ((data[offset] & 0xff) << 8) | (data[offset + 1] & 0xff);
			offset += 2;
			return (short) value;
		}

		int i32() throws IOException {
			need(4);
			int value = ((data[offset] & 0xff) << 24)
				| ((data[offset + 1] & 0xff) << 16)
				| ((data[offset + 2] & 0xff) << 8)
				| (data[offset + 3] & 0xff);
			offset += 4;
			return value;
		}

		int u16() throws IOException {
			need(2);
			int value = ((data[offset] & 0xff) << 8) | (data[offset + 1] & 0xff);
			offset += 2;
			return value;
		}

		String utf() throws IOException {
			int length = u16();
			need(length);
			String value = new String(data, offset, length, StandardCharsets.UTF_8);
			offset += length;
			return value;
		}

		long[] longs() throws IOException {
			int length = i32();
			if (length < 0 || length > 8192) {
				throw new IOException("NBT 长度异常");
			}
			long[] values = new long[length];
			for (int index = 0; index < length; index++) {
				need(8);
				long value = 0;
				for (int shift = 0; shift < 8; shift++) {
					value = (value << 8) | (data[offset++] & 0xffL);
				}
				values[index] = value;
			}
			return values;
		}

		void skip(int tag) throws IOException {
			skip(tag, 0);
		}

		void skip(int tag, int depth) throws IOException {
			if (depth > 64) {
				throw new IOException("NBT 嵌套过深");
			}
			switch (tag) {
				case END -> {
				}
				case BYTE -> {
					need(1);
					offset += 1;
				}
				case SHORT -> {
					need(2);
					offset += 2;
				}
				case INT, FLOAT -> {
					need(4);
					offset += 4;
				}
				case LONG, DOUBLE -> {
					need(8);
					offset += 8;
				}
				case BYTE_ARRAY -> {
					int length = i32();
					if (length < 0) {
						throw new IOException("NBT 长度异常");
					}
					need(length);
					offset += length;
				}
				case STRING -> {
					int length = u16();
					need(length);
					offset += length;
				}
				case LIST -> {
					int listType = u8();
					int length = i32();
					if (length < 0 || length > 1_000_000) {
						throw new IOException("NBT 长度异常");
					}
					if (listType == END) {
						return;
					}
					for (int index = 0; index < length; index++) {
						skip(listType, depth + 1);
					}
				}
				case COMPOUND -> {
					while (true) {
						int child = u8();
						if (child == END) {
							return;
						}
						int nameLength = u16();
						need(nameLength);
						offset += nameLength;
						skip(child, depth + 1);
					}
				}
				case INT_ARRAY, LONG_ARRAY -> {
					int length = i32();
					if (length < 0) {
						throw new IOException("NBT 长度异常");
					}
					long bytes = (long) length * (tag == INT_ARRAY ? 4L : 8L);
					if (bytes > limit - offset) {
						throw new IOException("NBT 超出文件末尾");
					}
					offset += (int) bytes;
				}
				default -> throw new IOException("未知 NBT 类型 " + tag);
			}
		}

		void need(int size) throws IOException {
			if (size < 0 || offset > limit - size) {
				throw new IOException("NBT 超出文件末尾");
			}
		}
	}
}
