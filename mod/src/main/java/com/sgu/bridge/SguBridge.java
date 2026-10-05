package com.sgu.bridge;

import com.sgu.bridge.store.RecordStore;
import net.fabricmc.api.ModInitializer;
import net.fabricmc.fabric.api.entity.event.v1.ServerLivingEntityEvents;
import net.fabricmc.fabric.api.event.lifecycle.v1.ServerLifecycleEvents;
import net.fabricmc.fabric.api.event.lifecycle.v1.ServerTickEvents;
import net.fabricmc.fabric.api.networking.v1.ServerPlayConnectionEvents;
import net.fabricmc.loader.api.FabricLoader;
import net.minecraft.server.MinecraftServer;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.world.damagesource.DamageSource;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

public final class SguBridge implements ModInitializer {
	public static final String MOD_ID = "sgu-bridge";
	public static final Logger LOGGER = LoggerFactory.getLogger(MOD_ID);
	public static final BridgeRuntime RUNTIME = new BridgeRuntime();

	@Override
	public void onInitialize() {
		RUNTIME.load();
		ServerLifecycleEvents.SERVER_STARTED.register(this::onStarted);
		ServerLifecycleEvents.SERVER_STOPPING.register(this::onStopping);
		ServerPlayConnectionEvents.DISCONNECT.register(this::onDisconnect);
		ServerLivingEntityEvents.AFTER_DEATH.register(this::onDeath);
		ServerTickEvents.END_SERVER_TICK.register(this::onTick);
		if (!FabricLoader.getInstance().isModLoaded("carpet")) {
			LOGGER.warn("未安装 Carpet，假人召唤记录和一键下线不可用");
		}
		LOGGER.info("SGU Bridge 已加载，配置目录 {}", RUNTIME.directory());
	}

	private void onStarted(MinecraftServer server) {
		RUNTIME.store().setStopping(false);
		RUNTIME.attach(server);
		RUNTIME.reconcileFakePlayers();
		RUNTIME.http().start();
		RUNTIME.uplink().start();
		RUNTIME.mapPush().start();
		RUNTIME.watchConfig();
	}

	private void onStopping(MinecraftServer server) {
		RUNTIME.store().setStopping(true);
		RUNTIME.stopWatching();
		RUNTIME.mapPush().stop();
		RUNTIME.uplink().stop();
		RUNTIME.http().stop();
		RUNTIME.store().flush();
		RUNTIME.detach();
	}

	private void onDisconnect(net.minecraft.server.network.ServerGamePacketListenerImpl listener, MinecraftServer server) {
		ServerPlayer player = listener.player;
		if (player == null) {
			return;
		}
		if (FakePlayers.isFake(player)) {
			RUNTIME.store().markFakeOffline(player, RecordStore.now());
			return;
		}
		RUNTIME.store().recordLogout(player);
	}

	private void onDeath(net.minecraft.world.entity.LivingEntity entity, DamageSource source) {
		if (!(entity instanceof ServerPlayer player) || FakePlayers.isFake(player)) {
			return;
		}
		String message = source.getLocalizedDeathMessage(player).getString();
		RUNTIME.store().recordDeath(player, message);
	}

	private void onTick(MinecraftServer server) {
		if (server.getTickCount() % 6000 != 0) {
			return;
		}
		boolean changed = false;
		for (ServerPlayer player : server.getPlayerList().getPlayers()) {
			if (FakePlayers.isFake(player)) {
				if (RUNTIME.store().touchFake(player)) {
					changed = true;
				}
			} else if (RUNTIME.store().recordSnapshot(player)) {
				changed = true;
			}
		}
		if (changed) {
			RUNTIME.store().save();
		}
	}
}
