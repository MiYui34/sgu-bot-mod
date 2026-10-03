package com.sgu.bridge;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.SecureRandom;
import java.util.HexFormat;

public final class BridgeConfig {
	private static final Logger LOGGER = LoggerFactory.getLogger("sgu-bridge");

	private final int port;
	private final String token;
	private final Path allowlistPath;

	private BridgeConfig(int port, String token, Path allowlistPath) {
		this.port = port;
		this.token = token;
		this.allowlistPath = allowlistPath;
	}

	public static BridgeConfig load(Path directory) {
		try {
			Files.createDirectories(directory);
		} catch (IOException e) {
			throw new IllegalStateException("无法创建配置目录 " + directory, e);
		}
		Path configPath = directory.resolve("config.json");
		Path allowlistPath = directory.resolve("command-allowlist.txt");
		if (!Files.exists(allowlistPath)) {
			try (InputStream in = BridgeConfig.class.getClassLoader().getResourceAsStream("default-allowlist.txt")) {
				if (in == null) {
					Files.writeString(allowlistPath, "list\n", StandardCharsets.UTF_8);
				} else {
					Files.writeString(allowlistPath, new String(in.readAllBytes(), StandardCharsets.UTF_8), StandardCharsets.UTF_8);
				}
			} catch (IOException e) {
				throw new IllegalStateException("无法写入指令白名单", e);
			}
		}
		int port = 8765;
		String token = randomToken();
		if (Files.exists(configPath)) {
			try {
				String raw = Files.readString(configPath, StandardCharsets.UTF_8);
				port = readInt(raw, "port", port);
				String found = readString(raw, "token");
				if (found != null && !found.isBlank()) {
					token = found;
				}
			} catch (IOException e) {
				LOGGER.warn("读取 config.json 失败，改用默认端口", e);
			}
		} else {
			String json = "{\n  \"port\": " + port + ",\n  \"token\": \"" + token + "\"\n}\n";
			try {
				Files.writeString(configPath, json, StandardCharsets.UTF_8);
			} catch (IOException e) {
				throw new IllegalStateException("无法写入 config.json", e);
			}
			LOGGER.info("已生成 {} ，把其中的 token 填到机器人的 BRIDGE_TOKEN", configPath);
		}
		return new BridgeConfig(port, token, allowlistPath);
	}

	public int port() {
		return port;
	}

	public String token() {
		return token;
	}

	public Path allowlistPath() {
		return allowlistPath;
	}

	private static String randomToken() {
		byte[] bytes = new byte[24];
		new SecureRandom().nextBytes(bytes);
		return HexFormat.of().formatHex(bytes);
	}

	private static int readInt(String json, String key, int fallback) {
		String value = readString(json, key);
		if (value == null) {
			int index = json.indexOf("\"" + key + "\"");
			if (index < 0) {
				return fallback;
			}
			int colon = json.indexOf(':', index);
			if (colon < 0) {
				return fallback;
			}
			int end = colon + 1;
			while (end < json.length() && Character.isWhitespace(json.charAt(end))) {
				end++;
			}
			int start = end;
			while (end < json.length() && Character.isDigit(json.charAt(end))) {
				end++;
			}
			try {
				return Integer.parseInt(json.substring(start, end));
			} catch (NumberFormatException e) {
				return fallback;
			}
		}
		try {
			return Integer.parseInt(value);
		} catch (NumberFormatException e) {
			return fallback;
		}
	}

	private static String readString(String json, String key) {
		String needle = "\"" + key + "\"";
		int index = json.indexOf(needle);
		if (index < 0) {
			return null;
		}
		int colon = json.indexOf(':', index + needle.length());
		if (colon < 0) {
			return null;
		}
		int quote = json.indexOf('"', colon + 1);
		if (quote < 0) {
			return null;
		}
		int end = json.indexOf('"', quote + 1);
		if (end < 0) {
			return null;
		}
		return json.substring(quote + 1, end);
	}
}
