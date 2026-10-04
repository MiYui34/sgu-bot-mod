package com.sgu.bridge.http;

import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import com.sgu.bridge.BridgeRuntime;
import com.sgu.bridge.CommandGuard;
import com.sgu.bridge.FakePlayers;
import com.sgu.bridge.SguBridge;
import com.sgu.bridge.world.RegionFiles;
import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;
import net.minecraft.commands.CommandSource;
import net.minecraft.commands.CommandSourceStack;
import net.minecraft.network.chat.Component;
import net.minecraft.server.MinecraftServer;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.server.permissions.PermissionSet;

import java.io.IOException;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.MessageDigest;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

public final class BridgeHttp {
	private static final Pattern REGION_FILE = Pattern.compile("^/v1/regions/(overworld|nether|end)/(r\\.-?\\d+\\.-?\\d+\\.mca)$");

	private final BridgeRuntime runtime;
	private HttpServer server;
	private ExecutorService executor;

	public BridgeHttp(BridgeRuntime runtime) {
		this.runtime = runtime;
	}

	public void start() {
		if (server != null) {
			return;
		}
		int port = runtime.config().port();
		try {
			server = HttpServer.create(new InetSocketAddress("127.0.0.1", port), 0);
		} catch (IOException e) {
			SguBridge.LOGGER.error("本机接口绑定 127.0.0.1:{} 失败", port, e);
			return;
		}
		server.createContext("/", this::handle);
		executor = Executors.newFixedThreadPool(2, runnable -> {
			Thread thread = new Thread(runnable, "sgu-bridge-http");
			thread.setDaemon(true);
			return thread;
		});
		server.setExecutor(executor);
		server.start();
		SguBridge.LOGGER.info("本机接口已监听 http://127.0.0.1:{}/", port);
	}

	public void stop() {
		if (server != null) {
			server.stop(0);
			server = null;
		}
		if (executor != null) {
			executor.shutdownNow();
			executor = null;
		}
	}

	private void handle(HttpExchange exchange) throws IOException {
		try {
			if (!authorized(exchange)) {
				send(exchange, 401, error("未授权").toString());
				return;
			}
			String method = exchange.getRequestMethod();
			String path = exchange.getRequestURI().getPath();
			if ("GET".equals(method) && "/v1/health".equals(path)) {
				JsonObject body = new JsonObject();
				body.addProperty("ok", true);
				send(exchange, 200, body.toString());
				return;
			}
			if ("GET".equals(method) && (path.equals("/v1/regions") || path.startsWith("/v1/regions/"))) {
				serveRegions(exchange, path);
				return;
			}
			JsonObject body = call(path, method, exchange);
			int status = body.has("status") ? body.get("status").getAsInt() : 200;
			body.remove("status");
			send(exchange, status, body.toString());
		} catch (TimeoutException e) {
			send(exchange, 504, error("服务器线程没有及时响应").toString());
		} catch (Exception e) {
			SguBridge.LOGGER.warn("接口处理失败", e);
			Throwable cause = e instanceof ExecutionException && e.getCause() != null ? e.getCause() : e;
			send(exchange, 500, error(cause.getMessage() == null ? "内部错误" : cause.getMessage()).toString());
		} finally {
			exchange.close();
		}
	}

	private JsonObject call(String path, String method, HttpExchange exchange) throws Exception {
		MinecraftServer minecraft = runtime.server();
		if (minecraft == null) {
			return status(503, error("服务器还没启动"));
		}
		String requestBody = new String(exchange.getRequestBody().readAllBytes(), StandardCharsets.UTF_8);
		CompletableFuture<JsonObject> future = new CompletableFuture<>();
		minecraft.execute(() -> {
			try {
				future.complete(dispatch(minecraft, method, path, exchange.getRequestURI().getRawQuery(), requestBody));
			} catch (Throwable t) {
				future.completeExceptionally(t);
			}
		});
		return future.get(8, TimeUnit.SECONDS);
	}

	private JsonObject dispatch(MinecraftServer minecraft, String method, String path, String query, String requestBody) {
		if ("GET".equals(method) && "/v1/fake-players".equals(path)) {
			JsonObject body = new JsonObject();
			body.add("players", runtime.store().listFake(minecraft));
			return body;
		}
		if ("GET".equals(method) && "/v1/players/online".equals(path)) {
			JsonObject body = new JsonObject();
			var array = new com.google.gson.JsonArray();
			for (ServerPlayer player : minecraft.getPlayerList().getPlayers()) {
				JsonObject row = new JsonObject();
				row.addProperty("name", player.getGameProfile().name());
				row.addProperty("uuid", player.getUUID().toString());
				row.addProperty("dimension", player.level().dimension().identifier().toString());
				row.addProperty("x", player.getX());
				row.addProperty("y", player.getY());
				row.addProperty("z", player.getZ());
				row.addProperty("yaw", player.getYRot());
				row.addProperty("fake", FakePlayers.isFake(player));
				array.add(row);
			}
			body.add("players", array);
			return body;
		}
		if ("GET".equals(method) && "/v1/players/last-logout".equals(path)) {
			return queryPlayer(minecraft, query, true);
		}
		if ("GET".equals(method) && "/v1/players/last-death".equals(path)) {
			return queryPlayer(minecraft, query, false);
		}
		if ("POST".equals(method) && path.startsWith("/v1/fake-players/") && path.endsWith("/kill")) {
			String encoded = path.substring("/v1/fake-players/".length(), path.length() - "/kill".length());
			return killFake(minecraft, decode(encoded));
		}
		if ("POST".equals(method) && "/v1/commands".equals(path)) {
			return runCommand(minecraft, requestBody);
		}
		return status(404, error("未知接口"));
	}

	private JsonObject queryPlayer(MinecraftServer minecraft, String query, boolean logout) {
		String name = queryValue(query, "name");
		if (name == null || name.isBlank()) {
			return status(400, error("缺少玩家名"));
		}
		String canonical = runtime.store().canonicalName(minecraft, name);
		JsonObject row = logout
			? runtime.store().queryLogout(canonical, runtime.store().playerOnline(minecraft, canonical))
			: runtime.store().queryDeath(canonical);
		if (row == null) {
			return status(404, error("没有找到该玩家的记录"));
		}
		row.addProperty("found", true);
		return row;
	}

	private JsonObject killFake(MinecraftServer minecraft, String name) {
		if (!FakePlayers.validName(name)) {
			return status(400, error("假人名字不合法"));
		}
		ServerPlayer player = minecraft.getPlayerList().getPlayerByName(name);
		if (player == null || !FakePlayers.isFake(player)) {
			return status(404, error("这个假人当前不在线"));
		}
		String output = execute(minecraft, "player " + name + " kill");
		runtime.store().markFakeOffline(player.getGameProfile().name(), com.sgu.bridge.store.RecordStore.now());
		JsonObject body = new JsonObject();
		body.addProperty("ok", true);
		body.addProperty("name", player.getGameProfile().name());
		body.addProperty("output", output);
		return body;
	}

	private JsonObject runCommand(MinecraftServer minecraft, String requestBody) {
		JsonObject input;
		try {
			input = JsonParser.parseString(requestBody).getAsJsonObject();
		} catch (Exception e) {
			return status(400, error("请求体不是 JSON"));
		}
		if (!input.has("command") || !input.get("command").isJsonPrimitive()) {
			return status(400, error("缺少 command"));
		}
		String command = CommandGuard.normalize(input.get("command").getAsString());
		if (CommandGuard.rejected(command)) {
			return status(400, error("指令为空、过长或含有换行"));
		}
		if (!CommandGuard.allowed(command, CommandGuard.readPrefixes(runtime.config()))) {
			JsonObject denied = error("指令不在白名单中");
			denied.addProperty("ok", false);
			return status(403, denied);
		}
		String output = execute(minecraft, command);
		JsonObject body = new JsonObject();
		body.addProperty("ok", true);
		body.addProperty("command", command);
		body.addProperty("output", output.isBlank() ? "(无输出)" : output);
		return body;
	}

	private static String execute(MinecraftServer minecraft, String command) {
		StringBuilder output = new StringBuilder();
		CommandSource source = new CommandSource() {
			@Override
			public void sendSystemMessage(Component message) {
				if (!output.isEmpty()) {
					output.append('\n');
				}
				output.append(message.getString());
			}

			@Override
			public boolean acceptsSuccess() {
				return true;
			}

			@Override
			public boolean acceptsFailure() {
				return true;
			}

			@Override
			public boolean shouldInformAdmins() {
				return false;
			}

			@Override
			public boolean alwaysAccepts() {
				return true;
			}
		};
		CommandSourceStack console = minecraft.createCommandSourceStack();
		CommandSourceStack stack = new CommandSourceStack(
			source,
			console.getPosition(),
			console.getRotation(),
			minecraft.overworld(),
			PermissionSet.ALL_PERMISSIONS,
			"SGU",
			Component.literal("SGU"),
			minecraft,
			null
		);
		try {
			minecraft.getCommands().performPrefixedCommand(stack, command);
		} catch (RuntimeException e) {
			if (!output.isEmpty()) {
				output.append('\n');
			}
			output.append(e.getMessage() == null ? e.toString() : e.getMessage());
		}
		return output.toString();
	}

	private void serveRegions(HttpExchange exchange, String path) throws IOException {
		Path root = runtime.worldRoot();
		if (root == null) {
			send(exchange, 503, error("世界目录还没准备好").toString());
			return;
		}
		if ("/v1/regions".equals(path)) {
			JsonObject body = new JsonObject();
			var files = new com.google.gson.JsonArray();
			for (RegionFiles.Listed file : RegionFiles.list(root)) {
				JsonObject row = new JsonObject();
				row.addProperty("dim", file.dim());
				row.addProperty("name", file.name());
				row.addProperty("size", file.size());
				row.addProperty("mtime", file.mtime());
				files.add(row);
			}
			body.add("files", files);
			send(exchange, 200, body.toString());
			return;
		}
		Matcher matcher = REGION_FILE.matcher(path);
		if (!matcher.matches()) {
			send(exchange, 404, error("未找到").toString());
			return;
		}
		Path file;
		try {
			file = RegionFiles.resolve(root, matcher.group(1), matcher.group(2));
		} catch (IOException e) {
			send(exchange, 404, error("未找到").toString());
			return;
		}
		long size = Files.size(file);
		exchange.getResponseHeaders().set("Content-Type", "application/octet-stream");
		exchange.sendResponseHeaders(200, size);
		try (OutputStream out = exchange.getResponseBody()) {
			Files.copy(file, out);
		}
	}

	private boolean authorized(HttpExchange exchange) {
		String expected = runtime.config().token();
		String header = exchange.getRequestHeaders().getFirst("Authorization");
		String provided = null;
		if (header != null && header.regionMatches(true, 0, "Bearer ", 0, 7)) {
			provided = header.substring(7).strip();
		}
		if (provided == null) {
			provided = exchange.getRequestHeaders().getFirst("X-Sgu-Token");
		}
		if (provided == null) {
			return false;
		}
		return MessageDigest.isEqual(expected.getBytes(StandardCharsets.UTF_8), provided.getBytes(StandardCharsets.UTF_8));
	}

	private static String queryValue(String query, String key) {
		if (query == null) {
			return null;
		}
		for (String part : query.split("&")) {
			int eq = part.indexOf('=');
			if (eq < 0) {
				continue;
			}
			if (decode(part.substring(0, eq)).equals(key)) {
				return decode(part.substring(eq + 1));
			}
		}
		return null;
	}

	private static String decode(String value) {
		return java.net.URLDecoder.decode(value, StandardCharsets.UTF_8);
	}

	private static JsonObject error(String message) {
		JsonObject body = new JsonObject();
		body.addProperty("error", message);
		return body;
	}

	private static JsonObject status(int code, JsonObject body) {
		body.addProperty("status", code);
		return body;
	}

	private static void send(HttpExchange exchange, int status, String body) throws IOException {
		byte[] bytes = body.getBytes(StandardCharsets.UTF_8);
		exchange.getResponseHeaders().set("Content-Type", "application/json; charset=utf-8");
		exchange.sendResponseHeaders(status, bytes.length);
		try (OutputStream out = exchange.getResponseBody()) {
			out.write(bytes);
		}
	}
}
