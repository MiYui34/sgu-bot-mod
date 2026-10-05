package com.sgu.bridge.mixin;

import com.mojang.brigadier.context.CommandContext;
import com.mojang.brigadier.exceptions.CommandSyntaxException;
import com.sgu.bridge.SguBridge;
import net.minecraft.commands.CommandSourceStack;
import net.minecraft.commands.arguments.DimensionArgument;
import net.minecraft.commands.arguments.coordinates.Vec3Argument;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.world.phys.Vec3;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.Shadow;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfoReturnable;

@Mixin(targets = "carpet.commands.PlayerCommand", remap = false)
public abstract class PlayerCommandMixin {
	@Shadow
	private static ServerPlayer getPlayer(CommandContext<CommandSourceStack> context) {
		throw new AssertionError();
	}

	@Inject(method = "spawn", at = @At("RETURN"))
	private static void sgu$spawn(CommandContext<CommandSourceStack> context, CallbackInfoReturnable<Integer> cir) {
		if (cir.getReturnValue() == 1) {
			record(context, false);
		}
	}

	@Inject(method = "shadow", at = @At("HEAD"))
	private static void sgu$shadowActor(CommandContext<CommandSourceStack> context, CallbackInfoReturnable<Integer> cir) {
		noteTarget(context, false);
	}

	@Inject(method = "shadow", at = @At("RETURN"))
	private static void sgu$shadow(CommandContext<CommandSourceStack> context, CallbackInfoReturnable<Integer> cir) {
		if (cir.getReturnValue() == 1) {
			record(context, true);
		}
	}

	@Inject(method = "kill", at = @At("RETURN"))
	private static void sgu$kill(CommandContext<CommandSourceStack> context, CallbackInfoReturnable<Integer> cir) {
		if (cir.getReturnValue() != null && cir.getReturnValue() == 1) {
			noteTarget(context, true);
		}
	}

	@Inject(method = "disconnect", at = @At("HEAD"), require = 0)
	private static void sgu$disconnect(CommandContext<CommandSourceStack> context, CallbackInfoReturnable<Integer> cir) {
		noteLogout(context);
	}

	private static void record(CommandContext<CommandSourceStack> context, boolean shadow) {
		try {
			CommandSourceStack source = context.getSource();
			String name = com.mojang.brigadier.arguments.StringArgumentType.getString(context, "player");
			Vec3 pos = source.getPosition();
			try {
				pos = Vec3Argument.getVec3(context, "position");
			} catch (IllegalArgumentException ignored) {
			}
			String dimension = source.getLevel().dimension().identifier().toString();
			try {
				dimension = DimensionArgument.getDimension(context, "dimension").dimension().identifier().toString();
			} catch (IllegalArgumentException | CommandSyntaxException ignored) {
			}
			String summonerSource = "command_block";
			String summonerName = source.getTextName();
			String summonerUuid = null;
			if (source.getEntity() instanceof ServerPlayer player) {
				summonerSource = "player";
				summonerName = player.getGameProfile().name();
				summonerUuid = player.getUUID().toString();
			} else if ("Server".equals(summonerName) || "Rcon".equalsIgnoreCase(summonerName)) {
				summonerSource = "console";
			}
			SguBridge.RUNTIME.store().recordSpawn(name, summonerName, summonerUuid, summonerSource, dimension, pos.x, pos.y, pos.z, shadow);
		} catch (RuntimeException e) {
			SguBridge.LOGGER.warn("记录假人召唤失败", e);
		}
	}

	private static void noteLogout(CommandContext<CommandSourceStack> context) {
		noteTarget(context, true);
	}

	private static void noteTarget(CommandContext<CommandSourceStack> context, boolean allowSelf) {
		try {
			ServerPlayer target = getPlayer(context);
			if (target == null) {
				return;
			}
			String actorSource = "command_block";
			String actorName = context.getSource().getTextName();
			if (context.getSource().getEntity() instanceof ServerPlayer player) {
				actorSource = "player";
				actorName = player.getGameProfile().name();
			} else if ("SGU".equals(actorName)) {
				actorSource = "bot";
				actorName = "机器人";
			} else if ("Server".equals(actorName) || "Rcon".equalsIgnoreCase(actorName)) {
				actorSource = "console";
			}
			if (!allowSelf && target.getGameProfile().name().equals(actorName)) {
				return;
			}
			SguBridge.RUNTIME.store().rememberLogout(target, actorName, actorSource);
		} catch (RuntimeException e) {
			SguBridge.LOGGER.warn("记录下线操作人失败", e);
		}
	}
}
