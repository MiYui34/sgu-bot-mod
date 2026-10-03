package com.sgu.bridge.store;

import com.google.gson.Gson;
import com.google.gson.GsonBuilder;
import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import com.sgu.bridge.FakePlayers;
import net.minecraft.server.level.ServerPlayer;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.AtomicMoveNotSupportedException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.time.OffsetDateTime;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;
import java.util.Locale;

public final class RecordStore {
	private static final Gson GSON = new GsonBuilder().setPrettyPrinting().create();

	private final Path path;
	private final List<JsonObject> fakePlayers = new ArrayList<>();
	private final List<JsonObject> logouts = new ArrayList<>();
	private final List<JsonObject> snapshots = new ArrayList<>();
	private final List<JsonObject> deaths = new ArrayList<>();

	public RecordStore(Path path) {
		this.path = path;
	}

	public synchronized void load() {
		fakePlayers.clear();
		logouts.clear();
		snapshots.clear();
		deaths.clear();
		if (!Files.exists(path)) {
			return;
		}
		try {
			JsonObject root = JsonParser.parseString(Files.readString(path, StandardCharsets.UTF_8)).getAsJsonObject();
			addAll(fakePlayers, root, "fakePlayers");
			addAll(logouts, root, "logouts");
			addAll(snapshots, root, "snapshots");
			addAll(deaths, root, "deaths");
		} catch (Exception e) {
			com.sgu.bridge.SguBridge.LOGGER.warn("读取 {} 失败，记录从空开始", path, e);
		}
	}

	public synchronized void save() {
		JsonObject root = new JsonObject();
		root.add("fakePlayers", copy(fakePlayers));
		root.add("logouts", copy(logouts));
		root.add("snapshots", copy(snapshots));
		root.add("deaths", copy(deaths));
		try {
			Files.createDirectories(path.getParent());
			Path tmp = path.resolveSibling(path.getFileName() + ".tmp");
			Files.writeString(tmp, GSON.toJson(root), StandardCharsets.UTF_8);
			try {
				Files.move(tmp, path, StandardCopyOption.REPLACE_EXISTING, StandardCopyOption.ATOMIC_MOVE);
			} catch (AtomicMoveNotSupportedException e) {
				Files.move(tmp, path, StandardCopyOption.REPLACE_EXISTING);
			}
		} catch (IOException e) {
			com.sgu.bridge.SguBridge.LOGGER.warn("保存记录失败", e);
		}
	}

	public synchronized void recordSpawn(String name, String summonerName, String summonerUuid, String summonerSource, String dimension, double x, double y, double z, boolean shadow) {
		JsonObject row = findOrCreate(fakePlayers, name);
		row.addProperty("name", name);
		row.addProperty("summonerName", summonerName);
		row.addProperty("summonerUuid", summonerUuid == null ? "" : summonerUuid);
		row.addProperty("summonerSource", summonerSource);
		row.addProperty("dimension", dimension);
		row.addProperty("x", x);
		row.addProperty("y", y);
		row.addProperty("z", z);
		row.addProperty("summonedAt", now());
		row.addProperty("killedAt", "");
		row.addProperty("online", true);
		row.addProperty("shadow", shadow);
		save();
	}

	public synchronized void ensureUnknownFake(ServerPlayer player) {
		String name = player.getGameProfile().name();
		JsonObject existing = find(fakePlayers, name);
		if (existing != null) {
			existing.addProperty("online", true);
			existing.addProperty("uuid", player.getUUID().toString());
			fillLive(existing, player);
			save();
			return;
		}
		JsonObject row = new JsonObject();
		row.addProperty("name", name);
		row.addProperty("uuid", player.getUUID().toString());
		row.addProperty("summonerName", "未知（模组启动前已存在）");
		row.addProperty("summonerUuid", "");
		row.addProperty("summonerSource", "unknown");
		row.addProperty("summonedAt", "");
		row.addProperty("killedAt", "");
		row.addProperty("online", true);
		row.addProperty("shadow", false);
		fillLive(row, player);
		fakePlayers.add(row);
		save();
	}

	public synchronized void markFakeOffline(String name, String time) {
		JsonObject row = find(fakePlayers, name);
		if (row == null) {
			return;
		}
		row.addProperty("online", false);
		if (!row.has("killedAt") || row.get("killedAt").getAsString().isEmpty()) {
			row.addProperty("killedAt", time);
		}
		save();
	}

	public synchronized void recordLogout(ServerPlayer player) {
		String time = now();
		JsonObject row = place(findOrCreate(logouts, player.getGameProfile().name()), player, time);
		row.addProperty("kind", "logout");
		place(findOrCreate(snapshots, player.getGameProfile().name()), player, time);
		save();
	}

	public synchronized boolean recordSnapshot(ServerPlayer player) {
		JsonObject existing = find(snapshots, player.getGameProfile().name());
		if (existing != null && samePlace(existing, player)) {
			return false;
		}
		place(findOrCreate(snapshots, player.getGameProfile().name()), player, now());
		return true;
	}

	public synchronized void recordDeath(ServerPlayer player, String message) {
		JsonObject row = place(findOrCreate(deaths, player.getGameProfile().name()), player, now());
		row.addProperty("message", message == null ? "" : message);
		save();
	}

	public synchronized JsonArray listFake(net.minecraft.server.MinecraftServer server) {
		JsonArray array = new JsonArray();
		List<JsonObject> rows = new ArrayList<>(fakePlayers);
		rows.sort(Comparator.comparing((JsonObject row) -> !row.get("online").getAsBoolean()).thenComparing(row -> text(row, "name")));
		for (JsonObject stored : rows) {
			JsonObject copy = stored.deepCopy();
			String name = text(copy, "name");
			var player = server.getPlayerList().getPlayerByName(name);
			if (player != null && FakePlayers.isFake(player)) {
				copy.addProperty("online", true);
				copy.addProperty("uuid", player.getUUID().toString());
				fillLive(copy, player);
			} else {
				copy.addProperty("online", false);
			}
			array.add(copy);
		}
		return array;
	}

	public synchronized JsonObject queryLogout(String name, boolean online) {
		JsonObject logout = find(logouts, name);
		JsonObject snapshot = find(snapshots, name);
		if (online) {
			return logout == null ? null : withKind(logout, "logout");
		}
		if (logout == null && snapshot == null) {
			return null;
		}
		if (logout == null) {
			return withKind(snapshot, "last_known");
		}
		if (snapshot != null && text(snapshot, "time").compareTo(text(logout, "time")) > 0) {
			return withKind(snapshot, "last_known");
		}
		return withKind(logout, "logout");
	}

	public synchronized JsonObject queryDeath(String name) {
		JsonObject row = find(deaths, name);
		return row == null ? null : row.deepCopy();
	}

	public synchronized boolean playerOnline(net.minecraft.server.MinecraftServer server, String name) {
		var player = server.getPlayerList().getPlayerByName(name);
		if (player != null && player.getGameProfile().name().equalsIgnoreCase(name)) {
			return true;
		}
		for (ServerPlayer online : server.getPlayerList().getPlayers()) {
			if (online.getGameProfile().name().equalsIgnoreCase(name) && !FakePlayers.isFake(online)) {
				return true;
			}
		}
		return false;
	}

	public synchronized String canonicalName(net.minecraft.server.MinecraftServer server, String name) {
		for (ServerPlayer online : server.getPlayerList().getPlayers()) {
			if (online.getGameProfile().name().equalsIgnoreCase(name)) {
				return online.getGameProfile().name();
			}
		}
		JsonObject found = find(logouts, name);
		if (found == null) {
			found = find(deaths, name);
		}
		if (found == null) {
			found = find(snapshots, name);
		}
		return found == null ? name : text(found, "name");
	}

	public static String now() {
		return OffsetDateTime.now().toString();
	}

	private static JsonObject withKind(JsonObject row, String kind) {
		JsonObject copy = row.deepCopy();
		copy.addProperty("kind", kind);
		return copy;
	}

	private static JsonObject place(JsonObject row, ServerPlayer player, String time) {
		row.addProperty("name", player.getGameProfile().name());
		row.addProperty("uuid", player.getUUID().toString());
		fillLive(row, player);
		row.addProperty("time", time);
		return row;
	}

	private static boolean samePlace(JsonObject row, ServerPlayer player) {
		if (!row.has("x") || !row.has("y") || !row.has("z")) {
			return false;
		}
		String dimension = player.level().dimension().identifier().toString();
		if (!dimension.equals(text(row, "dimension"))) {
			return false;
		}
		return Math.abs(row.get("x").getAsDouble() - player.getX()) < 1
				&& Math.abs(row.get("y").getAsDouble() - player.getY()) < 1
				&& Math.abs(row.get("z").getAsDouble() - player.getZ()) < 1;
	}

	private static void fillLive(JsonObject row, ServerPlayer player) {
		row.addProperty("dimension", player.level().dimension().identifier().toString());
		row.addProperty("x", player.getX());
		row.addProperty("y", player.getY());
		row.addProperty("z", player.getZ());
		row.addProperty("yaw", player.getYRot());
	}

	private static JsonObject findOrCreate(List<JsonObject> rows, String name) {
		JsonObject found = find(rows, name);
		if (found != null) {
			return found;
		}
		JsonObject created = new JsonObject();
		created.addProperty("name", name);
		rows.add(created);
		return created;
	}

	private static JsonObject find(List<JsonObject> rows, String name) {
		String key = name.toLowerCase(Locale.ROOT);
		for (JsonObject row : rows) {
			if (text(row, "name").toLowerCase(Locale.ROOT).equals(key)) {
				return row;
			}
		}
		return null;
	}

	private static String text(JsonObject row, String key) {
		return row.has(key) && !row.get(key).isJsonNull() ? row.get(key).getAsString() : "";
	}

	private static void addAll(List<JsonObject> target, JsonObject root, String key) {
		if (!root.has(key) || !root.get(key).isJsonArray()) {
			return;
		}
		for (var element : root.getAsJsonArray(key)) {
			if (element.isJsonObject()) {
				target.add(element.getAsJsonObject());
			}
		}
	}

	private static JsonArray copy(List<JsonObject> rows) {
		JsonArray array = new JsonArray();
		for (JsonObject row : rows) {
			array.add(row.deepCopy());
		}
		return array;
	}
}
