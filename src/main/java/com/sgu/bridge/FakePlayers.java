package com.sgu.bridge;

import net.minecraft.server.level.ServerPlayer;

public final class FakePlayers {
	private static final String FAKE_CLASS = "carpet.patches.EntityPlayerMPFake";

	private FakePlayers() {
	}

	public static boolean isFake(ServerPlayer player) {
		Class<?> type = player.getClass();
		while (type != null) {
			if (FAKE_CLASS.equals(type.getName())) {
				return true;
			}
			type = type.getSuperclass();
		}
		return false;
	}

	public static boolean validName(String name) {
		if (name == null || name.length() < 1 || name.length() > 16) {
			return false;
		}
		for (int i = 0; i < name.length(); i++) {
			char c = name.charAt(i);
			boolean ok = (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || c == '_';
			if (!ok) {
				return false;
			}
		}
		return true;
	}
}
