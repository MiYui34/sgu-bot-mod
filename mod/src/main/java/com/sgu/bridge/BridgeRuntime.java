package com.sgu.bridge;

import com.sgu.bridge.http.BridgeHttp;
import com.sgu.bridge.http.BridgeUplink;
import com.sgu.bridge.map.MapPush;
import com.sgu.bridge.store.RecordStore;
import net.minecraft.server.MinecraftServer;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.world.level.storage.LevelResource;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.MessageDigest;
import java.util.HexFormat;
import java.util.concurrent.atomic.AtomicBoolean;

public final class BridgeRuntime {
	private volatile BridgeConfig config;
	private RecordStore store;
	private BridgeHttp http;
	private BridgeUplink uplink;
	private MapPush mapPush;
	private Path directory;
	private final AtomicBoolean watching = new AtomicBoolean(false);
	private volatile Thread configWatcher;
	private volatile MinecraftServer server;
	private volatile Path worldRoot;
	private volatile String worldId = "";

	public void load() {
		directory = net.fabricmc.loader.api.FabricLoader.getInstance().getConfigDir().resolve("sgu-bridge");
		config = BridgeConfig.load(directory);
		store = new RecordStore(directory.resolve("records.json"));
		store.load();
		http = new BridgeHttp(this);
		uplink = new BridgeUplink(this);
		mapPush = new MapPush(this);
	}

	public void attach(MinecraftServer server) {
		this.server = server;
		Path root = server.getWorldPath(LevelResource.ROOT);
		this.worldRoot = root;
		try {
			String identity = root.toAbsolutePath().normalize() + "|" + server.overworld().getSeed();
			byte[] digest = MessageDigest.getInstance("SHA-256").digest(identity.getBytes(StandardCharsets.UTF_8));
			this.worldId = HexFormat.of().formatHex(digest);
		} catch (Exception e) {
			this.worldId = "";
		}
	}

	public void detach() {
		this.server = null;
		this.worldRoot = null;
		this.worldId = "";
	}

	public void watchConfig() {
		if (!watching.compareAndSet(false, true)) {
			return;
		}
		Thread thread = new Thread(this::pollConfig, "sgu-bridge-config");
		thread.setDaemon(true);
		configWatcher = thread;
		thread.start();
	}

	public void stopWatching() {
		watching.set(false);
		Thread thread = configWatcher;
		if (thread != null) {
			thread.interrupt();
		}
	}

	private void pollConfig() {
		Path path = directory.resolve("config.json");
		long seenModified = modifiedAt(path);
		long seenSize = sizeOf(path);
		while (watching.get() && configWatcher == Thread.currentThread()) {
			try {
				Thread.sleep(2000);
			} catch (InterruptedException e) {
				continue;
			}
			if (!watching.get() || configWatcher != Thread.currentThread()) {
				return;
			}
			long modified = modifiedAt(path);
			long size = sizeOf(path);
			if (modified == seenModified && size == seenSize) {
				continue;
			}
			BridgeConfig previous = config;
			BridgeConfig next = BridgeConfig.load(directory, previous);
			seenModified = modified;
			seenSize = size;
			if (next == previous) {
				continue;
			}
			boolean portChanged = next.port() != previous.port();
			config = next;
			if (portChanged) {
				SguBridge.LOGGER.info("本机端口改为 {}，正在重新监听", next.port());
				http.stop();
				http.start();
			}
			SguBridge.LOGGER.info("已热加载配置，正在重连云服");
			uplink.start();
			mapPush.start();
		}
	}

	private static long modifiedAt(Path path) {
		try {
			return Files.getLastModifiedTime(path).toMillis();
		} catch (IOException e) {
			return -1;
		}
	}

	private static long sizeOf(Path path) {
		try {
			return Files.size(path);
		} catch (IOException e) {
			return -1;
		}
	}

	public void reconcileFakePlayers() {
		MinecraftServer current = server;
		if (current == null) {
			return;
		}
		for (ServerPlayer player : current.getPlayerList().getPlayers()) {
			if (FakePlayers.isFake(player)) {
				store.ensureUnknownFake(player);
			}
		}
	}

	public MinecraftServer server() {
		return server;
	}

	public Path worldRoot() {
		return worldRoot;
	}

	public String worldId() {
		return worldId;
	}

	public BridgeConfig config() {
		return config;
	}

	public RecordStore store() {
		return store;
	}

	public BridgeHttp http() {
		return http;
	}

	public BridgeUplink uplink() {
		return uplink;
	}

	public MapPush mapPush() {
		return mapPush;
	}

	public Path directory() {
		return directory;
	}
}
