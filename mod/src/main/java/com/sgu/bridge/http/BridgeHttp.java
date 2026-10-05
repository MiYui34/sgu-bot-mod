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
import net.minecraft.network.chat.ClickEvent;
import net.minecraft.network.chat.Component;
import net.minecraft.network.chat.Style;
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
import java.util.Optional;
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
			String query = exchange.getRequestURI().getRawQuery();
			String requestBody = new String(exchange.getRequestBody().readAllBytes(), StandardCharsets.UTF_8);
			Reply reply = serve(method, path, query == null ? "" : query, requestBody);
			writeReply(exchange, reply);
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

	public Reply serve(String method, String path, String query, String requestBody) throws Exception {
		if ("GET".equals(method) && "/v1/health".equals(path)) {
			JsonObject body = new JsonObject();
			body.addProperty("ok", true);
			return Reply.json(200, body);
		}
		if ("GET".equals(method) && (path.equals("/v1/regions") || path.startsWith("/v1/regions/"))) {
			return serveRegions(path);
		}
		JsonObject body = call(path, method, query, requestBody == null ? "" : requestBody);
		int status = body.has("status") ? body.get("status").getAsInt() : 200;
		body.remove("status");
		return Reply.json(status, body);
	}

	private JsonObject call(String path, String method, String query, String requestBody) throws Exception {
		MinecraftServer minecraft = runtime.server();
		if (minecraft == null) {
			return status(503, error("服务器还没启动"));
		}
		if ("POST".equals(method) && "/v1/commands".equals(path)) {
			return runCommand(minecraft, requestBody);
		}
		CompletableFuture<JsonObject> future = new CompletableFuture<>();
		minecraft.execute(() -> {
			try {
				future.complete(dispatch(minecraft, method, path, query, requestBody));
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
		if ("POST".equals(method) && path.startsWith("/v1/fake-players/") && path.endsWith("/kill")
			&& path.length() > "/v1/fake-players/".length() + "/kill".length()) {
			String encoded = path.substring("/v1/fake-players/".length(), path.length() - "/kill".length());
			String name = decode(encoded);
			if (name == null) {
				return status(400, error("假人名字不合法"));
			}
			return killFake(minecraft, name, requestBody);
		}
		if ("POST".equals(method) && "/v1/name-prefix".equals(path)) {
			return setNamePrefix(minecraft, requestBody);
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
			? runtime.store().queryLogout(minecraft, canonical)
			: runtime.store().queryDeath(canonical);
		if (row == null) {
			return status(404, error("没有找到该玩家的记录"));
		}
		row.addProperty("found", true);
		return row;
	}

	private JsonObject killFake(MinecraftServer minecraft, String name, String requestBody) {
		if (!FakePlayers.validName(name)) {
			return status(400, error("假人名字不合法"));
		}
		ServerPlayer player = minecraft.getPlayerList().getPlayerByName(name);
		if (player == null || !FakePlayers.isFake(player)) {
			return status(404, error("这个假人当前不在线"));
		}
		String actor = actorName(requestBody);
		if (!actor.isEmpty()) {
			runtime.store().noteLogoutActor(player.getGameProfile().name(), actor, "qq");
		}
		String output = execute(minecraft, "player " + name + " kill");
		JsonObject body = new JsonObject();
		body.addProperty("ok", true);
		body.addProperty("name", player.getGameProfile().name());
		body.addProperty("output", output);
		return body;
	}

	private JsonObject runCommand(MinecraftServer minecraft, String requestBody) throws Exception {
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
		StringBuffer output = new StringBuffer();
		CompletableFuture<Void> ran = new CompletableFuture<>();
		minecraft.execute(() -> {
			try {
				perform(minecraft, command, output);
				ran.complete(null);
			} catch (Throwable t) {
				ran.completeExceptionally(t);
			}
		});
		ran.get(8, TimeUnit.SECONDS);
		awaitOutput(command, output);
		String text = output.toString();
		JsonObject body = new JsonObject();
		body.addProperty("ok", true);
		body.addProperty("command", command);
		body.addProperty("output", text.isBlank() ? "(无输出)" : text);
		return body;
	}

	private JsonObject setNamePrefix(MinecraftServer minecraft, String requestBody) {
		JsonObject input;
		try {
			input = JsonParser.parseString(requestBody).getAsJsonObject();
		} catch (Exception e) {
			return status(400, error("请求体不是 JSON"));
		}
		if (!input.has("officialId") || !input.get("officialId").isJsonPrimitive()
			|| !input.has("nickname") || !input.get("nickname").isJsonPrimitive()) {
			return status(400, error("缺少正版 ID 或昵称"));
		}
		String officialId = input.get("officialId").getAsString().strip();
		String nickname = input.get("nickname").getAsString().strip();
		if (nickname.startsWith("[") && nickname.endsWith("]") && nickname.length() > 2) {
			nickname = nickname.substring(1, nickname.length() - 1).strip();
		}
		if (!officialId.matches("[A-Za-z0-9_]{3,16}")) {
			return status(400, error("正版 ID 需为 3 到 16 位字母、数字或下划线"));
		}
		if (!nickname.matches("[\\p{IsHan}A-Za-z0-9_\\-]{1,16}")) {
			return status(400, error("昵称需为 1 到 16 位中文、字母、数字或下划线"));
		}
		String command = "name other prefix " + officialId + " [" + nickname + "]";
		if (CommandGuard.rejected(command)) {
			return status(400, error("指令不合法"));
		}
		String output = execute(minecraft, command);
		JsonObject body = new JsonObject();
		body.addProperty("ok", true);
		body.addProperty("officialId", officialId);
		body.addProperty("nickname", nickname);
		body.addProperty("command", command);
		body.addProperty("output", output.isBlank() ? "(无输出)" : output);
		return body;
	}

	private static String execute(MinecraftServer minecraft, String command) {
		StringBuffer output = new StringBuffer();
		perform(minecraft, command, output);
		return output.toString();
	}

	private static void perform(MinecraftServer minecraft, String command, StringBuffer output) {
		CommandSource source = new CommandSource() {
			@Override
			public void sendSystemMessage(Component message) {
				appendLine(output, plain(message));
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
			appendLine(output, e.getMessage() == null ? e.toString() : e.getMessage());
		}
	}

	private static void awaitOutput(String command, StringBuffer output) throws InterruptedException {
		boolean spark = "spark".equals(command) || command.startsWith("spark ");
		long start = System.nanoTime();
		long deadline = start + (spark ? 15_000_000_000L : 500_000_000L);
		long quiet = spark ? 400_000_000L : 50_000_000L;
		int seen = output.length();
		long changedAt = start;
		while (System.nanoTime() < deadline) {
			int length = output.length();
			if (length != seen) {
				seen = length;
				changedAt = System.nanoTime();
			}
			String text = output.toString();
			if (spark && sparkStillWorking(text)) {
				if (text.isBlank() && System.nanoTime() - start >= 2_000_000_000L) {
					return;
				}
				Thread.sleep(40);
				continue;
			}
			if (System.nanoTime() - changedAt >= quiet) {
				return;
			}
			Thread.sleep(20);
		}
	}

	private static boolean sparkStillWorking(String text) {
		if (text.isBlank()) {
			return true;
		}
		String lower = text.toLowerCase();
		if (lower.contains("https://") || lower.contains("http://")) {
			return false;
		}
		if (lower.contains("error") || lower.contains("not supported") || text.contains("错误") || text.contains("失败")) {
			return false;
		}
		return lower.contains("generating") || lower.contains("upload") || lower.contains("opening");
	}

	private static void appendLine(StringBuffer output, String line) {
		if (line == null || line.isBlank()) {
			return;
		}
		synchronized (output) {
			if (!output.isEmpty()) {
				output.append('\n');
			}
			output.append(line.strip());
		}
	}

	private static String plain(Component message) {
		StringBuilder text = new StringBuilder(message.getString());
		message.visit((style, part) -> {
			ClickEvent click = style.getClickEvent();
			if (click instanceof ClickEvent.OpenUrl open) {
				String url = open.uri().toString();
				if (!text.toString().contains(url)) {
					if (!text.isEmpty() && text.charAt(text.length() - 1) != '\n') {
						text.append('\n');
					}
					text.append(url);
				}
			}
			return Optional.empty();
		}, Style.EMPTY);
		return text.toString();
	}

	private Reply serveRegions(String path) throws IOException {
		Path root = runtime.worldRoot();
		if (root == null) {
			return Reply.json(503, error("世界目录还没准备好"));
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
			body.addProperty("world", runtime.worldId());
			return Reply.json(200, body);
		}
		Matcher matcher = REGION_FILE.matcher(path);
		if (!matcher.matches()) {
			return Reply.json(404, error("未找到"));
		}
		Path file;
		try {
			file = RegionFiles.resolve(root, matcher.group(1), matcher.group(2));
		} catch (IOException e) {
			return Reply.json(404, error("未找到"));
		}
		long size = Files.size(file);
		if (size > 128L * 1024 * 1024) {
			return Reply.json(413, error("区域文件过大"));
		}
		return Reply.bytes(200, Files.readAllBytes(file));
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
			if (key.equals(decode(part.substring(0, eq)))) {
				return decode(part.substring(eq + 1));
			}
		}
		return null;
	}

	private static String actorName(String requestBody) {
		if (requestBody == null || requestBody.isBlank()) {
			return "";
		}
		try {
			JsonObject input = JsonParser.parseString(requestBody).getAsJsonObject();
			if (!input.has("actor") || !input.get("actor").isJsonPrimitive()) {
				return "";
			}
			return input.get("actor").getAsString().strip();
		} catch (Exception e) {
			return "";
		}
	}

	private static String decode(String value) {
		try {
			return java.net.URLDecoder.decode(value, StandardCharsets.UTF_8);
		} catch (IllegalArgumentException e) {
			return null;
		}
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

	private static void writeReply(HttpExchange exchange, Reply reply) throws IOException {
		if (reply.binary()) {
			byte[] bytes = reply.bytes();
			exchange.getResponseHeaders().set("Content-Type", "application/octet-stream");
			exchange.sendResponseHeaders(reply.status(), bytes.length);
			try (OutputStream out = exchange.getResponseBody()) {
				out.write(bytes);
			}
			return;
		}
		send(exchange, reply.status(), reply.json());
	}

	private static void send(HttpExchange exchange, int status, String body) throws IOException {
		byte[] bytes = body.getBytes(StandardCharsets.UTF_8);
		exchange.getResponseHeaders().set("Content-Type", "application/json; charset=utf-8");
		exchange.sendResponseHeaders(status, bytes.length);
		try (OutputStream out = exchange.getResponseBody()) {
			out.write(bytes);
		}
	}

	public static final class Reply {
		private final int status;
		private final String json;
		private final byte[] bytes;

		private Reply(int status, String json, byte[] bytes) {
			this.status = status;
			this.json = json;
			this.bytes = bytes;
		}

		public static Reply json(int status, JsonObject body) {
			return new Reply(status, body.toString(), null);
		}

		public static Reply bytes(int status, byte[] bytes) {
			return new Reply(status, null, bytes);
		}

		public int status() {
			return status;
		}

		public String json() {
			return json;
		}

		public byte[] bytes() {
			return bytes;
		}

		public boolean binary() {
			return bytes != null;
		}
	}
}
