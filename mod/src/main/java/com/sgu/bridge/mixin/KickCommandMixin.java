package com.sgu.bridge.mixin;

import com.sgu.bridge.SguBridge;
import net.minecraft.commands.CommandSourceStack;
import net.minecraft.network.chat.Component;
import net.minecraft.server.level.ServerPlayer;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfoReturnable;

import java.util.Collection;

@Mixin(targets = "net.minecraft.server.commands.KickCommand")
public abstract class KickCommandMixin {
	@Inject(method = "kickPlayers", at = @At("HEAD"), require = 0)
	private static void sgu$kick(CommandSourceStack source, Collection<ServerPlayer> players, Component reason, CallbackInfoReturnable<Integer> cir) {
		if (players == null) {
			return;
		}
		try {
			String actorSource = "command_block";
			String actorName = source.getTextName();
			if (source.getEntity() instanceof ServerPlayer player) {
				actorSource = "player";
				actorName = player.getGameProfile().name();
			} else if ("SGU".equals(actorName)) {
				actorSource = "bot";
				actorName = "机器人";
			} else if ("Server".equals(actorName) || "Rcon".equalsIgnoreCase(actorName)) {
				actorSource = "console";
			}
			for (ServerPlayer target : players) {
				String name = target == null ? null : target.getGameProfile().name();
				if (name != null && !name.isBlank()) {
					SguBridge.RUNTIME.store().noteLogoutActor(name, actorName, actorSource);
				}
			}
		} catch (RuntimeException e) {
			SguBridge.LOGGER.warn("记录踢出操作人失败", e);
		}
	}
}
