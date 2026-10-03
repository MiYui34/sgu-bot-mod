package com.sgu.bridge;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.util.ArrayList;
import java.util.List;

public final class CommandGuard {
	private CommandGuard() {
	}

	public static String normalize(String raw) {
		if (raw == null) {
			return "";
		}
		String command = raw.strip();
		if (command.startsWith("/")) {
			command = command.substring(1).strip();
		}
		return command;
	}

	public static boolean rejected(String command) {
		return command.isEmpty()
			|| command.length() > 256
			|| command.indexOf('\n') >= 0
			|| command.indexOf('\r') >= 0
			|| command.indexOf('\0') >= 0;
	}

	public static boolean allowed(String command, List<String> prefixes) {
		if (rejected(command)) {
			return false;
		}
		for (String prefix : prefixes) {
			if (command.equals(prefix) || command.startsWith(prefix + " ")) {
				return true;
			}
		}
		return false;
	}

	public static List<String> readPrefixes(BridgeConfig config) {
		List<String> prefixes = new ArrayList<>();
		List<String> lines;
		try {
			lines = Files.readAllLines(config.allowlistPath(), StandardCharsets.UTF_8);
		} catch (IOException e) {
			return prefixes;
		}
		for (String line : lines) {
			String trimmed = line.strip();
			if (trimmed.isEmpty() || trimmed.startsWith("#")) {
				continue;
			}
			if (trimmed.startsWith("/")) {
				trimmed = trimmed.substring(1).strip();
			}
			if (!trimmed.isEmpty() && !rejected(trimmed)) {
				prefixes.add(trimmed);
			}
		}
		return prefixes;
	}
}
