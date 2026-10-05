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
import java.util.HashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

public final class RecordStore {
	private static final Gson GSON = new GsonBuilder().setPrettyPrinting().create();

	private final Path path;
	private final List<JsonObject> fakePlayers = new ArrayList<>();
	private final List<JsonObject> logouts = new ArrayList<>();
	private final List<JsonObject> snapshots = new ArrayList<>();
	private final List<JsonObject> deaths = new ArrayList<>();
	private final Map<String, PendingActor> pendingActors = new HashMap<>();
	private volatile boolean stopping;
	private static final ExecutorService WRITER = Executors.newSingleThreadExecutor(runnable -> {
		Thread thread = new Thread(runnable, "sgu-bridge-records");
		thread.setDaemon(true);
		return thread;
	});
	private final Object writeLock = new Object();
	private final Object fileLock = new Object();
	private Snapshot pending;
	private boolean writerBusy;
	private long revision;
	private long written;

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

	// 调用方多在服务器主线程上，这里只生成内容，写盘交给后台线程，连续多次保存只写最新一份。
	public void save() {
		Snapshot snapshot = snapshot();
		synchronized (writeLock) {
			pending = snapshot;
			if (writerBusy) {
				return;
			}
			writerBusy = true;
		}
		try {
			WRITER.execute(this::drain);
		} catch (RuntimeException e) {
			synchronized (writeLock) {
				writerBusy = false;
			}
			flush();
		}
	}

	// 关服时用，当前线程直接写完再返回。
	public void flush() {
		Snapshot snapshot = snapshot();
		synchronized (writeLock) {
			pending = null;
		}
		write(snapshot);
	}

	private synchronized Snapshot snapshot() {
		JsonObject root = new JsonObject();
		root.add("fakePlayers", copy(fakePlayers));
		root.add("logouts", copy(logouts));
		root.add("snapshots", copy(snapshots));
		root.add("deaths", copy(deaths));
		return new Snapshot(++revision, GSON.toJson(root));
	}

	private void drain() {
		while (true) {
			Snapshot next;
			synchronized (writeLock) {
				next = pending;
				pending = null;
				if (next == null) {
					writerBusy = false;
					return;
				}
			}
			write(next);
		}
	}

	private void write(Snapshot snapshot) {
		synchronized (fileLock) {
			if (snapshot.revision <= written) {
				return;
			}
			try {
				Files.createDirectories(path.getParent());
				Path tmp = path.resolveSibling(path.getFileName() + ".tmp");
				Files.writeString(tmp, snapshot.json, StandardCharsets.UTF_8);
				try {
					Files.move(tmp, path, StandardCopyOption.REPLACE_EXISTING, StandardCopyOption.ATOMIC_MOVE);
				} catch (AtomicMoveNotSupportedException e) {
					Files.move(tmp, path, StandardCopyOption.REPLACE_EXISTING);
				}
				written = snapshot.revision;
			} catch (IOException e) {
				com.sgu.bridge.SguBridge.LOGGER.warn("保存记录失败", e);
			}
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
		row.addProperty("actorName", "");
		row.addProperty("actorSource", "");
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
		row.addProperty("actorName", "");
		row.addProperty("actorSource", "");
		row.addProperty("online", true);
		row.addProperty("shadow", false);
		fillLive(row, player);
		fakePlayers.add(row);
		save();
	}

	public void setStopping(boolean stopping) {
		this.stopping = stopping;
	}

	public synchronized void noteLogoutActor(String playerName, String actorName, String actorSource) {
		if (playerName == null || playerName.isBlank()) {
			return;
		}
		String key = playerName.toLowerCase(Locale.ROOT);
		PendingActor existing = pendingActors.get(key);
		if (existing != null && !existing.expired()) {
			return;
		}
		String name = actorName == null ? "" : actorName.strip();
		if (name.length() > 64) {
			name = name.substring(0, 64);
		}
		if (name.isEmpty()) {
			return;
		}
		pendingActors.put(key, new PendingActor(name, actorSource == null ? "" : actorSource, System.nanoTime()));
	}

	public synchronized void rememberLogout(ServerPlayer player, String fallbackName, String fallbackSource) {
		String name = player.getGameProfile().name();
		if (!FakePlayers.isFake(player)) {
			noteLogoutActor(name, fallbackName, fallbackSource);
			return;
		}
		JsonObject row = find(fakePlayers, name);
		if (row == null) {
			row = new JsonObject();
			row.addProperty("name", name);
			row.addProperty("uuid", player.getUUID().toString());
			row.addProperty("summonerName", "未知");
			row.addProperty("summonerUuid", "");
			row.addProperty("summonerSource", "unknown");
			row.addProperty("summonedAt", "");
			row.addProperty("shadow", false);
			row.addProperty("online", true);
			fakePlayers.add(row);
		}
		PendingActor pending = consumeActor(name);
		String actorName = pending != null ? pending.name : fallbackName;
		String actorSource = pending != null ? pending.source : fallbackSource;
		if ((pending != null || text(row, "actorName").isEmpty()) && actorName != null && !actorName.isBlank()) {
			row.addProperty("actorName", actorName.strip());
			row.addProperty("actorSource", actorSource == null ? "" : actorSource);
		}
		if (text(row, "killedAt").isEmpty()) {
			row.addProperty("killedAt", now());
		}
		fillLive(row, player);
		save();
	}

	public synchronized void markFakeOffline(ServerPlayer player, String time) {
		String name = player.getGameProfile().name();
		JsonObject row = find(fakePlayers, name);
		if (row == null) {
			row = new JsonObject();
			row.addProperty("name", name);
			row.addProperty("uuid", player.getUUID().toString());
			row.addProperty("summonerName", "未知");
			row.addProperty("summonerUuid", "");
			row.addProperty("summonerSource", "unknown");
			row.addProperty("summonedAt", "");
			row.addProperty("shadow", false);
			fakePlayers.add(row);
		}
		row.addProperty("online", false);
		row.addProperty("killedAt", time);
		fillLive(row, player);
		writeActor(row, name, "", "");
		save();
	}

	public synchronized boolean touchFake(ServerPlayer player) {
		JsonObject row = find(fakePlayers, player.getGameProfile().name());
		if (row == null || !flag(row, "online")) {
			return false;
		}
		if (samePlace(row, player)) {
			return false;
		}
		fillLive(row, player);
		return true;
	}

	public synchronized void recordLogout(ServerPlayer player) {
		String time = now();
		String name = player.getGameProfile().name();
		JsonObject row = place(findOrCreate(logouts, name), player, time);
		row.addProperty("kind", "logout");
		row.remove("actorName");
		row.remove("actorSource");
		writeActor(row, name, name, "self");
		place(findOrCreate(snapshots, name), player, time);
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
		rows.sort(Comparator.comparing((JsonObject row) -> !flag(row, "online")).thenComparing(row -> text(row, "name")));
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

	public synchronized JsonObject queryLogout(net.minecraft.server.MinecraftServer server, String name) {
		JsonObject fake = find(fakePlayers, name);
		if (fake != null) {
			JsonObject copy = fake.deepCopy();
			copy.addProperty("fake", true);
			String storedName = text(copy, "name");
			ServerPlayer live = server.getPlayerList().getPlayerByName(storedName);
			if (live != null && FakePlayers.isFake(live)) {
				fillLive(copy, live);
				copy.addProperty("online", true);
				copy.addProperty("kind", "online");
				copy.addProperty("time", text(copy, "summonedAt"));
				return copy;
			}
			copy.addProperty("online", false);
			String killedAt = text(copy, "killedAt");
			copy.addProperty("kind", killedAt.isEmpty() ? "last_known" : "logout");
			copy.addProperty("time", killedAt.isEmpty() ? text(copy, "summonedAt") : killedAt);
			return copy;
		}
		boolean online = playerOnline(server, name);
		JsonObject logout = find(logouts, name);
		JsonObject snapshot = find(snapshots, name);
		JsonObject row;
		if (online) {
			row = logout == null ? null : withKind(logout, "logout");
		} else if (logout == null && snapshot == null) {
			row = null;
		} else if (logout == null) {
			row = withKind(snapshot, "last_known");
		} else if (snapshot != null && text(snapshot, "time").compareTo(text(logout, "time")) > 0) {
			row = withKind(snapshot, "last_known");
		} else {
			row = withKind(logout, "logout");
		}
		if (row != null) {
			row.addProperty("fake", false);
		}
		return row;
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
		JsonObject found = find(fakePlayers, name);
		if (found == null) {
			found = find(logouts, name);
		}
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

	private void writeActor(JsonObject row, String playerName, String fallbackName, String fallbackSource) {
		if (!text(row, "actorName").isEmpty()) {
			pendingActors.remove(playerName.toLowerCase(Locale.ROOT));
			return;
		}
		PendingActor actor = consumeActor(playerName);
		if (actor == null && stopping) {
			row.addProperty("actorName", "服务器关闭");
			row.addProperty("actorSource", "server");
			return;
		}
		if (actor == null) {
			row.addProperty("actorName", fallbackName);
			row.addProperty("actorSource", fallbackSource);
			return;
		}
		row.addProperty("actorName", actor.name);
		row.addProperty("actorSource", actor.source);
	}

	private PendingActor consumeActor(String playerName) {
		PendingActor actor = pendingActors.remove(playerName.toLowerCase(Locale.ROOT));
		if (actor == null || actor.expired()) {
			return null;
		}
		return actor;
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
		var value = row.get(key);
		return value != null && value.isJsonPrimitive() ? value.getAsString() : "";
	}

	private static boolean flag(JsonObject row, String key) {
		var value = row.get(key);
		return value != null && value.isJsonPrimitive() && value.getAsJsonPrimitive().isBoolean() && value.getAsBoolean();
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

	private static final class Snapshot {
		private final long revision;
		private final String json;

		private Snapshot(long revision, String json) {
			this.revision = revision;
			this.json = json;
		}
	}

	private static final class PendingActor {
		private static final long TTL_NANOS = 15_000_000_000L;

		private final String name;
		private final String source;
		private final long at;

		private PendingActor(String name, String source, long at) {
			this.name = name;
			this.source = source;
			this.at = at;
		}

		private boolean expired() {
			return System.nanoTime() - at > TTL_NANOS;
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
