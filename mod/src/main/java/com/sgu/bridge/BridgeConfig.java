package com.sgu.bridge;

import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.SecureRandom;
import java.util.HexFormat;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

public final class BridgeConfig {
	private static final Logger LOGGER = LoggerFactory.getLogger("sgu-bridge");

	private final int port;
	private final String token;
	private final String cloudUrl;
	private final Path allowlistPath;

	private BridgeConfig(int port, String token, String cloudUrl, Path allowlistPath) {
		this.port = port;
		this.token = token;
		this.cloudUrl = cloudUrl;
		this.allowlistPath = allowlistPath;
	}

	public static BridgeConfig load(Path directory) {
		return load(directory, null);
	}

	public static BridgeConfig load(Path directory, BridgeConfig previous) {
		try {
			Files.createDirectories(directory);
		} catch (IOException e) {
			if (previous != null) {
				LOGGER.warn("无法打开配置目录，继续使用当前配置：{}", e.getMessage());
				return previous;
			}
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
				if (previous != null) {
					LOGGER.warn("无法写入指令白名单，继续使用当前配置：{}", e.getMessage());
					return previous;
				}
				throw new IllegalStateException("无法写入指令白名单", e);
			}
		}
		int port = previous == null ? 8765 : previous.port;
		String token = previous == null ? randomToken() : previous.token;
		String cloudUrl = previous == null ? "" : previous.cloudUrl;
		if (Files.exists(configPath)) {
			try {
				String raw = Files.readString(configPath, StandardCharsets.UTF_8);
				JsonObject root;
				try {
					root = JsonParser.parseString(raw).getAsJsonObject();
				} catch (RuntimeException e) {
					if (previous != null) {
						LOGGER.warn("config.json 不是完整的 JSON，继续使用当前配置");
						return previous;
					}
					LOGGER.warn("config.json 不是合法 JSON（多余的逗号或缺引号），已尽量读出其中的设置，请尽快改正");
					root = salvage(raw);
				}
				port = readPort(root, port);
				String found = readString(root, "token");
				if (found != null && !found.isBlank()) {
					token = found.strip();
				}
				String cloud = readString(root, "cloudUrl");
				if (cloud != null) {
					cloudUrl = cloud.strip();
				}
			} catch (IOException e) {
				if (previous != null) {
					LOGGER.warn("读取 config.json 失败，继续使用当前配置：{}", e.getMessage());
					return previous;
				}
				LOGGER.warn("读取 config.json 失败，改用默认端口", e);
			}
		} else if (previous != null) {
			LOGGER.warn("config.json 不存在，继续使用当前配置");
			return previous;
		} else {
			String json = "{\n  \"port\": " + port + ",\n  \"token\": \"" + token + "\",\n  \"cloudUrl\": \"\"\n}\n";
			try {
				Files.writeString(configPath, json, StandardCharsets.UTF_8);
			} catch (IOException e) {
				throw new IllegalStateException("无法写入 config.json", e);
			}
			LOGGER.info("已生成 {} ，把其中的 token 填到机器人的 BRIDGE_TOKEN，cloudUrl 填网页地图的公网地址", configPath);
		}
		return new BridgeConfig(port, token, cloudUrl, allowlistPath);
	}

	public int port() {
		return port;
	}

	public String token() {
		return token;
	}

	public String cloudUrl() {
		return cloudUrl;
	}

	public Path allowlistPath() {
		return allowlistPath;
	}

	private static String randomToken() {
		byte[] bytes = new byte[24];
		new SecureRandom().nextBytes(bytes);
		return HexFormat.of().formatHex(bytes);
	}

	private static JsonObject salvage(String raw) {
		JsonObject root = new JsonObject();
		Matcher port = Pattern.compile("\"port\"\\s*:\\s*\"?(\\d{1,5})").matcher(raw);
		if (port.find()) {
			root.addProperty("port", port.group(1));
		}
		for (String key : new String[] {"token", "cloudUrl"}) {
			Matcher value = Pattern.compile("\"" + key + "\"\\s*:\\s*\"([^\"]*)\"").matcher(raw);
			if (value.find()) {
				root.addProperty(key, value.group(1));
			}
		}
		return root;
	}

	private static int readPort(JsonObject root, int fallback) {
		JsonElement value = root.get("port");
		if (value == null || !value.isJsonPrimitive()) {
			return fallback;
		}
		int port;
		try {
			port = Integer.parseInt(value.getAsString().strip());
		} catch (NumberFormatException e) {
			LOGGER.warn("config.json 里的 port 不是数字，继续使用 {}", fallback);
			return fallback;
		}
		if (port < 1 || port > 65535) {
			LOGGER.warn("config.json 里的 port 超出范围，继续使用 {}", fallback);
			return fallback;
		}
		return port;
	}

	private static String readString(JsonObject root, String key) {
		JsonElement value = root.get(key);
		if (value == null || !value.isJsonPrimitive()) {
			return null;
		}
		return value.getAsString();
	}
}
