package com.sgu.bridge.http;

import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import com.sgu.bridge.BridgeRuntime;
import com.sgu.bridge.SguBridge;
import com.sgu.bridge.http.BridgeHttp.Reply;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.WebSocket;
import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;
import java.util.zip.Deflater;
import java.util.zip.GZIPOutputStream;
import java.time.Duration;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicLong;
import java.util.function.BooleanSupplier;

public final class BridgeUplink {
	private final BridgeRuntime runtime;
	private final AtomicBoolean running = new AtomicBoolean(false);
	private volatile WebSocket socket;
	private volatile Thread thread;
	private static final long PING_NANOS = TimeUnit.SECONDS.toNanos(20);
	private static final long SILENT_NANOS = TimeUnit.SECONDS.toNanos(60);
	private final AtomicLong generation = new AtomicLong();
	private final AtomicLong session = new AtomicLong();
	private ExecutorService workers;
	private HttpClient client;
	private final Object sendLock = new Object();
	private CompletableFuture<WebSocket> tail = CompletableFuture.completedFuture(null);

	public BridgeUplink(BridgeRuntime runtime) {
		this.runtime = runtime;
	}

	public synchronized void start() {
		try {
			endpoint(runtime.config().cloudUrl());
		} catch (IllegalArgumentException e) {
			if (running.get()) {
				reconnect();
			} else {
				SguBridge.LOGGER.info("未配置 cloudUrl，仍只监听本机接口");
			}
			return;
		}
		if (running.get()) {
			reconnect();
			return;
		}
		long mine = session.incrementAndGet();
		running.set(true);
		client = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(15)).build();
		workers = Executors.newFixedThreadPool(2, runnable -> {
			Thread worker = new Thread(runnable, "sgu-bridge-uplink-job");
			worker.setDaemon(true);
			return worker;
		});
		Thread created = new Thread(() -> loop(mine), "sgu-bridge-uplink");
		created.setDaemon(true);
		thread = created;
		created.start();
	}

	public synchronized void reconnect() {
		generation.incrementAndGet();
		dropSocket();
		Thread current = thread;
		if (current != null) {
			current.interrupt();
		}
	}

	// 只发停止信号，不等线程退出，关服时不拖住服务器主线程。
	public synchronized void stop() {
		running.set(false);
		session.incrementAndGet();
		generation.incrementAndGet();
		dropSocket();
		if (thread != null) {
			thread.interrupt();
			thread = null;
		}
		if (workers != null) {
			workers.shutdownNow();
			workers = null;
		}
		if (client != null) {
			client.shutdownNow();
			client = null;
		}
	}

	private boolean alive(long mine) {
		return running.get() && session.get() == mine;
	}

	// 云服每 15 秒 ping 一次，这边也定时 ping。一分钟收不到任何东西就当连接已死，主动断开重连。
	public static void holdOpen(WebSocket ws, CompletableFuture<Void> closed, AtomicLong lastSeen, BooleanSupplier alive) throws InterruptedException {
		long nextPing = System.nanoTime() + PING_NANOS;
		while (true) {
			try {
				closed.get(1, TimeUnit.SECONDS);
				return;
			} catch (TimeoutException e) {
				// 继续检查心跳
			} catch (ExecutionException e) {
				return;
			}
			if (!alive.getAsBoolean()) {
				ws.abort();
				return;
			}
			if (ws.isInputClosed() || ws.isOutputClosed()) {
				return;
			}
			long now = System.nanoTime();
			if (now - lastSeen.get() > SILENT_NANOS) {
				SguBridge.LOGGER.warn("云服超过 60 秒没有回应，重新连接");
				ws.abort();
				return;
			}
			if (now >= nextPing) {
				nextPing = now + PING_NANOS;
				try {
					ws.sendPing(ByteBuffer.allocate(0));
				} catch (IllegalStateException ignored) {
					// 上一个 ping 还没发完，下一轮再发
				}
			}
		}
	}

	private void dropSocket() {
		WebSocket current = socket;
		socket = null;
		if (current != null) {
			current.abort();
		}
	}

	private void loop(long mine) {
		long delay = 1000;
		boolean reportedMissing = false;
		while (alive(mine)) {
			long stamp = generation.get();
			URI uri;
			try {
				uri = endpoint(runtime.config().cloudUrl());
				reportedMissing = false;
			} catch (IllegalArgumentException e) {
				dropSocket();
				if (!reportedMissing) {
					SguBridge.LOGGER.info("未配置 cloudUrl，仍只监听本机接口");
					reportedMissing = true;
				}
				if (!pause(delay, stamp, mine)) {
					return;
				}
				delay = Math.min(delay * 2, 30_000);
				continue;
			}
			try {
				connectOnce(uri, mine);
				delay = 1000;
			} catch (InterruptedException e) {
				if (!alive(mine)) {
					return;
				}
				delay = 1000;
				continue;
			} catch (Exception e) {
				if (!alive(mine)) {
					return;
				}
				if (generation.get() != stamp) {
					delay = 1000;
					continue;
				}
				String message = e.getMessage() == null ? e.getClass().getSimpleName() : e.getMessage();
				SguBridge.LOGGER.warn("连接云服失败：{}，{} 秒后重试", message, delay / 1000);
			}
			if (!pause(delay, stamp, mine)) {
				return;
			}
			if (generation.get() == stamp) {
				delay = Math.min(delay * 2, 30_000);
			} else {
				delay = 1000;
			}
		}
	}

	private boolean pause(long delay, long stamp, long mine) {
		if (!alive(mine)) {
			return false;
		}
		if (generation.get() != stamp) {
			return true;
		}
		try {
			Thread.sleep(delay);
		} catch (InterruptedException e) {
			if (!alive(mine)) {
				return false;
			}
		}
		return alive(mine);
	}

	private void connectOnce(URI uri, long mine) throws Exception {
		HttpClient current = client;
		if (current == null) {
			throw new InterruptedException();
		}
		SessionListener listener = new SessionListener();
		WebSocket opened = current.newWebSocketBuilder()
			.header("Authorization", "Bearer " + runtime.config().token())
			.buildAsync(uri, listener)
			.get(20, TimeUnit.SECONDS);
		if (!alive(mine)) {
			opened.abort();
			return;
		}
		socket = opened;
		synchronized (sendLock) {
			tail = listener.authSend;
		}
		boolean announced = false;
		try {
			boolean accepted;
			try {
				accepted = listener.auth.get(10, TimeUnit.SECONDS);
			} catch (TimeoutException e) {
				throw new java.io.IOException("云服没有接受这条连接");
			}
			if (!accepted) {
				throw new java.io.IOException("云服拒绝了连接");
			}
			announced = true;
			SguBridge.LOGGER.info("已连接云服 {}", uri);
			holdOpen(opened, listener.closed, listener.lastSeen, () -> alive(mine));
		} finally {
			opened.abort();
			if (socket == opened) {
				socket = null;
			}
		}
		if (announced && alive(mine)) {
			SguBridge.LOGGER.info("与云服的连接已断开");
		}
	}

	private void enqueue(WebSocket ws, boolean text, Object payload) {
		if (ws != socket) {
			return;
		}
		synchronized (sendLock) {
			tail = tail.handle((value, error) -> null).thenCompose(ignored -> text
				? ws.sendText((String) payload, true)
				: ws.sendBinary((ByteBuffer) payload, true));
		}
	}

	private void answer(WebSocket ws, String text) {
		JsonObject request;
		try {
			request = JsonParser.parseString(text).getAsJsonObject();
		} catch (Exception e) {
			return;
		}
		String op = field(request, "op");
		String id = field(request, "id");
		if (!"req".equals(op) || id == null || !id.matches("[A-Za-z0-9_-]{1,40}")) {
			return;
		}
		String path = field(request, "path");
		String query = field(request, "query");
		String body = field(request, "body");
		path = path == null ? "" : path;
		query = query == null ? "" : query;
		body = body == null ? "" : body;
		try {
			URI parsed = URI.create("http://bridge.local" + (path.startsWith("/") ? path : "/" + path));
			path = parsed.getPath();
			if (query.isEmpty() && parsed.getRawQuery() != null) {
				query = parsed.getRawQuery();
			}
		} catch (IllegalArgumentException e) {
			sendJson(ws, id, 400, error("路径不合法"));
			return;
		}
		String method = field(request, "method");
		method = method == null ? "GET" : method;
		try {
			Reply reply = runtime.http().serve(method, path, query, body);
			if (reply.binary()) {
				sendFile(ws, id, reply.status(), reply.bytes());
			} else {
				sendJson(ws, id, reply.status(), JsonParser.parseString(reply.json()));
			}
		} catch (TimeoutException e) {
			sendJson(ws, id, 504, error("服务器线程没有及时响应"));
		} catch (Exception e) {
			Throwable cause = e instanceof ExecutionException && e.getCause() != null ? e.getCause() : e;
			SguBridge.LOGGER.warn("云服请求处理失败", cause);
			sendJson(ws, id, 500, error(cause.getMessage() == null ? "内部错误" : cause.getMessage()));
		}
	}

	private void sendJson(WebSocket ws, String id, int status, com.google.gson.JsonElement body) {
		byte[] raw = body.toString().getBytes(StandardCharsets.UTF_8);
		byte[] compressed = shrink(raw);
		if (compressed != null) {
			sendFrame(ws, id, status, compressed, (byte) 0x03);
			return;
		}
		JsonObject response = new JsonObject();
		response.addProperty("id", id);
		response.addProperty("op", "res");
		response.addProperty("status", status);
		response.add("body", body);
		enqueue(ws, true, response.toString());
	}

	private void sendFile(WebSocket ws, String id, int status, byte[] file) {
		byte[] compressed = shrink(file);
		if (compressed != null) {
			sendFrame(ws, id, status, compressed, (byte) 0x01);
			return;
		}
		sendFrame(ws, id, status, file, (byte) 0);
	}

	private void sendFrame(WebSocket ws, String id, int status, byte[] payload, byte flags) {
		byte[] idBytes = id.getBytes(StandardCharsets.UTF_8);
		ByteBuffer frame = ByteBuffer.allocate(6 + idBytes.length + payload.length);
		frame.put((byte) 2);
		frame.putShort((short) idBytes.length);
		frame.put(idBytes);
		frame.putShort((short) status);
		frame.put(flags);
		frame.put(payload);
		frame.flip();
		enqueue(ws, false, frame);
	}

	private static byte[] shrink(byte[] raw) {
		if (raw.length < 256) {
			return null;
		}
		try {
			byte[] compressed = gzip(raw);
			if (compressed.length + 16 < raw.length) {
				return compressed;
			}
		} catch (IOException e) {
			SguBridge.LOGGER.warn("数据包压缩失败：{}", e.getMessage());
		}
		return null;
	}

	private static byte[] gzip(byte[] raw) throws IOException {
		ByteArrayOutputStream out = new ByteArrayOutputStream(Math.max(64, raw.length / 2));
		try (FastGzip gzip = new FastGzip(out)) {
			gzip.write(raw);
		}
		return out.toByteArray();
	}

	private static final class FastGzip extends GZIPOutputStream {
		FastGzip(ByteArrayOutputStream out) throws IOException {
			super(out);
			Deflater previous = def;
			def = new Deflater(Deflater.BEST_SPEED, true);
			previous.end();
		}
	}

	private static String field(JsonObject object, String key) {
		com.google.gson.JsonElement value = object.get(key);
		return value != null && value.isJsonPrimitive() ? value.getAsString() : null;
	}

	private static JsonObject error(String message) {
		JsonObject body = new JsonObject();
		body.addProperty("error", message);
		return body;
	}

	public static URI endpoint(String cloudUrl) {
		if (cloudUrl == null || cloudUrl.isBlank()) {
			throw new IllegalArgumentException("empty");
		}
		String raw = cloudUrl.trim();
		while (raw.endsWith("/")) {
			raw = raw.substring(0, raw.length() - 1);
		}
		if (raw.startsWith("https://")) {
			return URI.create("wss://" + raw.substring("https://".length()) + "/bridge");
		}
		if (raw.startsWith("http://")) {
			return URI.create("ws://" + raw.substring("http://".length()) + "/bridge");
		}
		if (raw.startsWith("wss://") || raw.startsWith("ws://")) {
			return URI.create(raw.endsWith("/bridge") ? raw : raw + "/bridge");
		}
		throw new IllegalArgumentException("bad");
	}

	private final class SessionListener implements WebSocket.Listener {
		private final StringBuilder incoming = new StringBuilder();
		private final CompletableFuture<Boolean> auth = new CompletableFuture<>();
		private final CompletableFuture<Void> closed = new CompletableFuture<>();
		private volatile CompletableFuture<WebSocket> authSend = CompletableFuture.completedFuture(null);
		private volatile boolean authed;
		private final AtomicLong lastSeen = new AtomicLong(System.nanoTime());

		@Override
		public void onOpen(WebSocket webSocket) {
			lastSeen.set(System.nanoTime());
			webSocket.request(1);
			JsonObject hello = new JsonObject();
			hello.addProperty("op", "auth");
			hello.addProperty("token", runtime.config().token());
			authSend = webSocket.sendText(hello.toString(), true)
				.whenComplete((value, error) -> {
					if (error != null) {
						webSocket.abort();
					}
				});
		}

		@Override
		public CompletableFuture<?> onPing(WebSocket webSocket, ByteBuffer message) {
			lastSeen.set(System.nanoTime());
			webSocket.request(1);
			return null;
		}

		@Override
		public CompletableFuture<?> onPong(WebSocket webSocket, ByteBuffer message) {
			lastSeen.set(System.nanoTime());
			webSocket.request(1);
			return null;
		}

		@Override
		public CompletableFuture<?> onBinary(WebSocket webSocket, ByteBuffer data, boolean last) {
			lastSeen.set(System.nanoTime());
			webSocket.request(1);
			return null;
		}

		@Override
		public CompletableFuture<?> onText(WebSocket webSocket, CharSequence data, boolean last) {
			lastSeen.set(System.nanoTime());
			incoming.append(data);
			if (incoming.length() > 4 * 1024 * 1024) {
				incoming.setLength(0);
				webSocket.abort();
				return null;
			}
			webSocket.request(1);
			if (!last) {
				return null;
			}
			String text = incoming.toString();
			incoming.setLength(0);
			if (!authed) {
				try {
					JsonObject message = JsonParser.parseString(text).getAsJsonObject();
					if (message.has("op") && "auth".equals(message.get("op").getAsString()) && message.has("ok") && message.get("ok").getAsBoolean()) {
						authed = true;
						auth.complete(true);
					}
				} catch (Exception ignored) {
					auth.complete(false);
				}
				return null;
			}
			ExecutorService pool = workers;
			if (pool != null) {
				pool.submit(() -> answer(webSocket, text));
			}
			return null;
		}

		@Override
		public CompletableFuture<?> onClose(WebSocket webSocket, int statusCode, String reason) {
			auth.complete(false);
			closed.complete(null);
			return null;
		}

		@Override
		public void onError(WebSocket webSocket, Throwable error) {
			SguBridge.LOGGER.warn("云服连接异常：{}", error.getMessage() == null ? error.getClass().getSimpleName() : error.getMessage());
			auth.complete(false);
			closed.complete(null);
			webSocket.abort();
		}
	}
}
