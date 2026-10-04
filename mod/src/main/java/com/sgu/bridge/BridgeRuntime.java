package com.sgu.bridge;

import com.sgu.bridge.http.BridgeHttp;
import com.sgu.bridge.store.RecordStore;
import net.minecraft.server.MinecraftServer;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.world.level.storage.LevelResource;

import java.nio.file.Path;

public final class BridgeRuntime {
	private BridgeConfig config;
	private RecordStore store;
	private BridgeHttp http;
	private Path directory;
	private volatile MinecraftServer server;
	private volatile Path worldRoot;

	public void load() {
		directory = net.fabricmc.loader.api.FabricLoader.getInstance().getConfigDir().resolve("sgu-bridge");
		config = BridgeConfig.load(directory);
		store = new RecordStore(directory.resolve("records.json"));
		store.load();
		http = new BridgeHttp(this);
	}

	public void attach(MinecraftServer server) {
		this.server = server;
		this.worldRoot = server.getWorldPath(LevelResource.ROOT);
	}

	public void detach() {
		this.server = null;
		this.worldRoot = null;
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

	public BridgeConfig config() {
		return config;
	}

	public RecordStore store() {
		return store;
	}

	public BridgeHttp http() {
		return http;
	}

	public Path directory() {
		return directory;
	}
}
