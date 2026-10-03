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
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfoReturnable;

@Mixin(targets = "carpet.commands.PlayerCommand", remap = false)
public abstract class PlayerCommandMixin {
	@Inject(method = "spawn", at = @At("RETURN"))
	private static void sgu$spawn(CommandContext<CommandSourceStack> context, CallbackInfoReturnable<Integer> cir) {
		if (cir.getReturnValue() == 1) {
			record(context, false);
		}
	}

	@Inject(method = "shadow", at = @At("RETURN"))
	private static void sgu$shadow(CommandContext<CommandSourceStack> context, CallbackInfoReturnable<Integer> cir) {
		if (cir.getReturnValue() == 1) {
			record(context, true);
		}
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
}
