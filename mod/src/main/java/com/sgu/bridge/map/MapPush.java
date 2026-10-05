package com.sgu.bridge.map;

import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import com.sgu.bridge.BridgeRuntime;
import com.sgu.bridge.SguBridge;
import com.sgu.bridge.http.BridgeUplink;
import com.sgu.bridge.world.RegionFiles;

import java.io.IOException;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.WebSocket;
import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;
import java.nio.file.AtomicMoveNotSupportedException;
import java.nio.file.Files;
import java.nio.file.NoSuchFileException;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.time.Duration;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Deque;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.LinkedBlockingDeque;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicLong;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

// 绘制、压缩、上传都在守护线程上。服务器主线程只调用 start 和 stop，两者都不等待后台线程。
public final class MapPush {
	private static final int PAINTERS = 12;
	private static final long BYTES_PER_SECOND = 1_000_000L;
	private static final int QUEUE_LIMIT = 64;
	private static final long REPAINT_GAP_MS = 60_000L;
	private static final long SETTLE_MS = 3_000L;
	private static final long MAX_REGION_BYTES = 96L * 1024 * 1024;
	private static final Pattern REGION_NAME = Pattern.compile("r\\.(-?\\d+)\\.(-?\\d+)\\.mca");
	private static final String STAMP_FILE = "map-stamps.txt";

	private final BridgeRuntime runtime;
	private Session session;

	public MapPush(BridgeRuntime runtime) {
		this.runtime = runtime;
	}

	public synchronized void start() {
		boolean configured;
		try {
			BridgeUplink.endpoint(runtime.config().cloudUrl());
			configured = true;
		} catch (IllegalArgumentException e) {
			configured = false;
		}
		if (session != null) {
			session.reconnect();
			return;
		}
		if (!configured) {
			return;
		}
		session = new Session(runtime.worldId());
		session.start();
	}

	public synchronized void stop() {
		Session current = session;
		session = null;
		if (current != null) {
			current.stop();
		}
	}

	private static int dimIndex(String dim) {
		return switch (dim) {
			case "overworld" -> 0;
			case "nether" -> 1;
			case "end" -> 2;
			default -> -1;
		};
	}

	private static ByteBuffer frame(int dim, int tileX, int tileZ, byte[] packed) {
		ByteBuffer buffer = ByteBuffer.allocate(10 + packed.length);
		buffer.put((byte) 4);
		buffer.put((byte) dim);
		buffer.putInt(tileX);
		buffer.putInt(tileZ);
		buffer.put(packed);
		buffer.flip();
		return buffer;
	}

	private static String describe(Throwable error) {
		return error.getMessage() == null ? error.getClass().getSimpleName() : error.getMessage();
	}

	private final class Session {
		private final String world;
		private final AtomicBoolean alive = new AtomicBoolean(true);
		private final AtomicLong generation = new AtomicLong();
		private final Object jobs = new Object();
		private final Object linkLock = new Object();
		private final Deque<RegionJob> urgentJobs = new ArrayDeque<>();
		private final Deque<RegionJob> backgroundJobs = new ArrayDeque<>();
		private final LinkedBlockingDeque<Outbound> urgentOut = new LinkedBlockingDeque<>(48);
		private final LinkedBlockingDeque<Outbound> backgroundOut = new LinkedBlockingDeque<>(48);
		private final Map<String, long[]> stamps = new ConcurrentHashMap<>();
		private final Map<String, Integer> failures = new ConcurrentHashMap<>();
		private final Map<String, Long> cooldown = new ConcurrentHashMap<>();
		private final Map<String, Long> paintedAt = new ConcurrentHashMap<>();
		private final Set<String> inflight = ConcurrentHashMap.newKeySet();
		private final List<Thread> threads = new ArrayList<>();
		private final HttpClient client = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(15)).build();
		private volatile boolean linked;
		private volatile boolean stampsDirty;
		private volatile WebSocket socket;
		private volatile Thread linkThread;
		private long tokens = BYTES_PER_SECOND;
		private long lastRefill = System.nanoTime();

		Session(String world) {
			this.world = world == null ? "" : world;
		}

		void start() {
			loadStamps();
			linkThread = spawn("sgu-bridge-map-link", this::linkLoop, Thread.NORM_PRIORITY);
			spawn("sgu-bridge-map-send", this::sendLoop, Thread.NORM_PRIORITY);
			spawn("sgu-bridge-map-scan", this::scanLoop, Thread.NORM_PRIORITY - 1);
			for (int index = 1; index <= PAINTERS; index++) {
				spawn("sgu-bridge-map-" + index, this::paintLoop, Thread.NORM_PRIORITY - 1);
			}
		}

		void stop() {
			alive.set(false);
			generation.incrementAndGet();
			dropSocket();
			for (Thread thread : threads) {
				thread.interrupt();
			}
			client.shutdownNow();
			wakeAll();
			saveStamps();
		}

		void reconnect() {
			generation.incrementAndGet();
			dropSocket();
			Thread thread = linkThread;
			if (thread != null) {
				thread.interrupt();
			}
		}

		private Thread spawn(String name, Runnable task, int priority) {
			Thread thread = new Thread(task, name);
			thread.setDaemon(true);
			thread.setPriority(priority);
			threads.add(thread);
			thread.start();
			return thread;
		}

		private void wakeAll() {
			synchronized (jobs) {
				jobs.notifyAll();
			}
			synchronized (linkLock) {
				linkLock.notifyAll();
			}
		}

		private void dropSocket() {
			linked = false;
			WebSocket current = socket;
			socket = null;
			if (current != null) {
				current.abort();
			}
			wakeAll();
		}

		private void linkLoop() {
			long delay = 1000;
			while (alive.get()) {
				long stamp = generation.get();
				URI uri;
				try {
					uri = BridgeUplink.endpoint(runtime.config().cloudUrl());
				} catch (IllegalArgumentException e) {
					dropSocket();
					if (!pause(delay, stamp)) {
						return;
					}
					delay = Math.min(delay * 2, 30_000);
					continue;
				}
				try {
					connectOnce(uri);
					delay = 1000;
				} catch (InterruptedException e) {
					if (!alive.get()) {
						return;
					}
					delay = 1000;
					continue;
				} catch (Exception e) {
					if (!alive.get()) {
						return;
					}
					if (generation.get() != stamp) {
						delay = 1000;
						continue;
					}
					SguBridge.LOGGER.warn("地图上传连接失败：{}，{} 秒后重试", describe(e), delay / 1000);
				}
				if (!pause(delay, stamp)) {
					return;
				}
				delay = generation.get() == stamp ? Math.min(delay * 2, 30_000) : 1000;
			}
		}

		private boolean pause(long delay, long stamp) {
			if (!alive.get()) {
				return false;
			}
			if (generation.get() != stamp) {
				return true;
			}
			try {
				Thread.sleep(delay);
			} catch (InterruptedException e) {
				// reconnect 会打断睡眠，直接进入下一轮
			}
			return alive.get();
		}

		private void connectOnce(URI uri) throws Exception {
			SessionListener listener = new SessionListener();
			WebSocket opened = client.newWebSocketBuilder()
				.header("Authorization", "Bearer " + runtime.config().token())
				.buildAsync(uri, listener)
				.get(20, TimeUnit.SECONDS);
			if (!alive.get()) {
				opened.abort();
				return;
			}
			socket = opened;
			boolean announced = false;
			try {
				boolean accepted;
				try {
					accepted = listener.auth.get(10, TimeUnit.SECONDS);
				} catch (java.util.concurrent.TimeoutException e) {
					throw new IOException("云服没有接受地图连接");
				}
				if (!accepted) {
					throw new IOException("云服拒绝了地图连接，请确认云服已更新到支持地图上传的版本");
				}
				listener.authSend.get(10, TimeUnit.SECONDS);
				linked = true;
				announced = true;
				wakeAll();
				SguBridge.LOGGER.info("地图上传已连接");
				BridgeUplink.holdOpen(opened, listener.closed, listener.lastSeen, alive::get);
			} finally {
				opened.abort();
				if (socket == opened) {
					socket = null;
				}
				linked = false;
				wakeAll();
				if (announced && alive.get()) {
					SguBridge.LOGGER.info("地图上传已断开");
				}
			}
		}

		private void waitLinked() throws InterruptedException {
			synchronized (linkLock) {
				while (alive.get() && !linked) {
					linkLock.wait(1000);
				}
			}
		}

		private void sendLoop() {
			while (alive.get()) {
				Outbound item = null;
				try {
					if (!linked) {
						waitLinked();
						continue;
					}
					item = urgentOut.poll();
					if (item == null) {
						item = backgroundOut.poll();
					}
					if (item == null) {
						item = urgentOut.poll(250, TimeUnit.MILLISECONDS);
						if (item == null) {
							continue;
						}
					}
					WebSocket ws = socket;
					if (ws == null || !linked) {
						requeue(item);
						item = null;
						continue;
					}
					refill();
					if (item.urgent) {
						tokens = Math.max(tokens - item.bytes, -BYTES_PER_SECOND);
					} else {
						if (!waitTokens(item)) {
							item = null;
							continue;
						}
						tokens -= item.bytes;
					}
					ws.sendBinary(item.frame, true).get(60, TimeUnit.SECONDS);
					finish(item.batch, true);
					item = null;
				} catch (InterruptedException e) {
					if (item != null) {
						finish(item.batch, false);
					}
					if (!alive.get()) {
						return;
					}
				} catch (Exception e) {
					if (item != null) {
						finish(item.batch, false);
					}
					if (alive.get()) {
						SguBridge.LOGGER.warn("地图图块发送失败：{}", describe(e));
					}
					linked = false;
					WebSocket ws = socket;
					if (ws != null) {
						ws.abort();
					}
				}
			}
		}

		// 后台图块按令牌桶等待；等待期间有视口图块进来就先让路，返回 false 表示这块已放回队首。
		private boolean waitTokens(Outbound item) throws InterruptedException {
			while (alive.get() && tokens < item.bytes) {
				if (!urgentOut.isEmpty() || !linked) {
					requeue(item);
					return false;
				}
				long deficit = item.bytes - tokens;
				Thread.sleep(Math.max(1L, Math.min(200L, deficit * 1000L / BYTES_PER_SECOND)));
				refill();
			}
			if (!alive.get()) {
				finish(item.batch, false);
				return false;
			}
			return true;
		}

		private void requeue(Outbound item) {
			LinkedBlockingDeque<Outbound> queue = item.urgent ? urgentOut : backgroundOut;
			if (!queue.offerFirst(item)) {
				finish(item.batch, false);
			}
		}

		private void refill() {
			long now = System.nanoTime();
			long delta = Math.max(0L, now - lastRefill);
			lastRefill = now;
			tokens = Math.min(BYTES_PER_SECOND, tokens + delta * BYTES_PER_SECOND / 1_000_000_000L);
		}

		private void finish(Batch batch, boolean sent) {
			if (!sent) {
				batch.failed = true;
			}
			if (batch.left.decrementAndGet() != 0) {
				return;
			}
			inflight.remove(batch.inflightKey);
			if (batch.failed || batch.stampKey == null) {
				return;
			}
			paintedAt.put(batch.stampKey, System.currentTimeMillis());
			if (!batch.stable) {
				cooldown.put(batch.stampKey, System.currentTimeMillis() + SETTLE_MS);
				return;
			}
			if (batch.chunkErrors == 0) {
				failures.remove(batch.stampKey);
				remember(batch.stampKey, batch.size, batch.mtime);
				return;
			}
			int tries = failures.merge(batch.stampKey, 1, Integer::sum);
			if (tries >= 3) {
				failures.remove(batch.stampKey);
				remember(batch.stampKey, batch.size, batch.mtime);
				SguBridge.LOGGER.warn("{} 有 {} 个区块没能绘成地表，已先上传读到的部分", batch.stampKey, batch.chunkErrors);
				return;
			}
			cooldown.put(batch.stampKey, System.currentTimeMillis() + 10_000L);
			SguBridge.LOGGER.warn("{} 有 {} 个区块没能绘成地表，将重试", batch.stampKey, batch.chunkErrors);
		}

		private void scanLoop() {
			while (alive.get()) {
				try {
					if (linked) {
						scan();
					}
					if (stampsDirty) {
						saveStamps();
					}
				} catch (Exception e) {
					SguBridge.LOGGER.warn("扫描区域失败：{}", describe(e));
				}
				try {
					Thread.sleep(5000);
				} catch (InterruptedException e) {
					if (!alive.get()) {
						return;
					}
				}
			}
		}

		private void scan() throws IOException {
			Path root = runtime.worldRoot();
			if (root == null) {
				return;
			}
			long now = System.currentTimeMillis();
			cooldown.values().removeIf(until -> until <= now);
			int queued = 0;
			for (RegionFiles.Listed file : RegionFiles.list(root)) {
				String key = file.dim() + "/" + file.name();
				long[] known = stamps.get(key);
				if (known != null && known[0] == file.size() && known[1] == file.mtime()) {
					continue;
				}
				if (cooldown.containsKey(key) || now - file.mtime() < SETTLE_MS) {
					continue;
				}
				Long painted = paintedAt.get(key);
				if (painted != null && now - painted < REPAINT_GAP_MS) {
					continue;
				}
				Matcher matcher = REGION_NAME.matcher(file.name());
				if (!matcher.matches() || dimIndex(file.dim()) < 0) {
					continue;
				}
				int regionX;
				int regionZ;
				try {
					regionX = Integer.parseInt(matcher.group(1));
					regionZ = Integer.parseInt(matcher.group(2));
				} catch (NumberFormatException e) {
					continue;
				}
				if (Math.abs((long) regionX) >= 500_000 || Math.abs((long) regionZ) >= 500_000) {
					continue;
				}
				if (!inflight.add(key)) {
					continue;
				}
				synchronized (jobs) {
					if (backgroundJobs.size() >= QUEUE_LIMIT) {
						inflight.remove(key);
						break;
					}
					backgroundJobs.addLast(RegionJob.region(file.dim(), file.name(), regionX, regionZ, key));
					jobs.notifyAll();
				}
				queued++;
			}
			if (queued > 0) {
				SguBridge.LOGGER.debug("后台绘制 {} 个区域", queued);
			}
		}

		private void paintLoop() {
			while (alive.get()) {
				RegionJob job;
				try {
					job = takeJob();
				} catch (InterruptedException e) {
					continue;
				}
				if (job == null) {
					return;
				}
				try {
					paint(job);
				} catch (InterruptedException e) {
					inflight.remove(job.inflightKey);
				} catch (Exception e) {
					inflight.remove(job.inflightKey);
					if (job.stamp) {
						cooldown.put(job.inflightKey, System.currentTimeMillis() + 10_000L);
					}
					if (!(e instanceof NoSuchFileException)) {
						SguBridge.LOGGER.warn("绘制 {} 失败：{}", job.inflightKey, describe(e));
					}
				}
			}
		}

		private RegionJob takeJob() throws InterruptedException {
			synchronized (jobs) {
				while (alive.get() && (!linked || (urgentJobs.isEmpty() && backgroundJobs.isEmpty()))) {
					jobs.wait(1000);
				}
				if (!alive.get()) {
					return null;
				}
				if (!urgentJobs.isEmpty()) {
					return urgentJobs.removeFirst();
				}
				return backgroundJobs.removeFirst();
			}
		}

		private void paint(RegionJob job) throws Exception {
			Path root = runtime.worldRoot();
			if (root == null) {
				inflight.remove(job.inflightKey);
				return;
			}
			int dim = dimIndex(job.dim);
			Path file;
			try {
				file = RegionFiles.resolve(root, job.dim, job.name);
			} catch (IOException e) {
				if (!job.single) {
					throw new NoSuchFileException(job.name);
				}
				// 视口要的是还没生成过的地方，回一张透明图，云服就不会一直等这块。
				Batch batch = new Batch(job.inflightKey, null, 0, 0, true, 0, 1);
				urgentOut.put(new Outbound(frame(dim, job.tileX, job.tileZ, ChunkSurface.blankTile()), true, batch));
				return;
			}
			long size = Files.size(file);
			long mtime = Files.getLastModifiedTime(file).toMillis();
			if (size < 8192 || size > MAX_REGION_BYTES) {
				throw new IOException("区域文件大小异常（" + size + " 字节）");
			}
			byte[] data = Files.readAllBytes(file);
			boolean stable = size == data.length
				&& size == Files.size(file)
				&& mtime == Files.getLastModifiedTime(file).toMillis();
			int minY = "overworld".equals(job.dim) ? -64 : 0;
			Path regionDir = file.getParent();
			int[] errors = new int[1];
			List<Piece> pieces = new ArrayList<>(4);
			if (job.single) {
				pieces.add(new Piece(job.tileX, job.tileZ, ChunkSurface.gzipTile(data, regionDir, job.tileX, job.tileZ, minY, true, errors)));
			} else {
				for (int dz = 0; dz < 2; dz++) {
					for (int dx = 0; dx < 2; dx++) {
						int tileX = job.regionX * 2 + dx;
						int tileZ = job.regionZ * 2 + dz;
						pieces.add(new Piece(tileX, tileZ, ChunkSurface.gzipTile(data, regionDir, tileX, tileZ, minY, false, errors)));
					}
				}
			}
			Batch batch = new Batch(job.inflightKey, job.stamp ? job.inflightKey : null, size, mtime, stable, errors[0], pieces.size());
			LinkedBlockingDeque<Outbound> queue = job.single ? urgentOut : backgroundOut;
			for (int index = 0; index < pieces.size(); index++) {
				Piece piece = pieces.get(index);
				try {
					queue.put(new Outbound(frame(dim, piece.tileX, piece.tileZ, piece.packed), job.single, batch));
				} catch (InterruptedException e) {
					for (int rest = index; rest < pieces.size(); rest++) {
						finish(batch, false);
					}
					throw e;
				}
			}
		}

		private boolean enqueueUrgent(String dim, int tileX, int tileZ) {
			int regionX = Math.floorDiv(tileX, 2);
			int regionZ = Math.floorDiv(tileZ, 2);
			String key = dim + "@" + tileX + "@" + tileZ;
			if (!inflight.add(key)) {
				return false;
			}
			synchronized (jobs) {
				if (urgentJobs.size() >= QUEUE_LIMIT) {
					inflight.remove(key);
					return false;
				}
				urgentJobs.addFirst(RegionJob.tile(dim, "r." + regionX + "." + regionZ + ".mca", tileX, tileZ, key));
				jobs.notifyAll();
			}
			return true;
		}

		private void acceptNeed(String text) {
			JsonObject message;
			try {
				message = JsonParser.parseString(text).getAsJsonObject();
			} catch (RuntimeException e) {
				return;
			}
			JsonElement op = message.get("op");
			JsonElement tiles = message.get("tiles");
			if (op == null || !op.isJsonPrimitive() || !"need".equals(op.getAsString()) || tiles == null || !tiles.isJsonArray()) {
				return;
			}
			int accepted = 0;
			for (JsonElement element : tiles.getAsJsonArray()) {
				if (accepted >= QUEUE_LIMIT) {
					break;
				}
				try {
					JsonObject tile = element.getAsJsonObject();
					String dim = tile.get("dim").getAsString();
					int tileX = tile.get("x").getAsInt();
					int tileZ = tile.get("z").getAsInt();
					if (dimIndex(dim) < 0 || Math.abs(tileX) > 1_000_000 || Math.abs(tileZ) > 1_000_000) {
						continue;
					}
					if (enqueueUrgent(dim, tileX, tileZ)) {
						accepted++;
					}
				} catch (RuntimeException ignored) {
					// 这一项格式不对，跳过，其余照常处理
				}
			}
		}

		private void remember(String key, long size, long mtime) {
			stamps.put(key, new long[] {size, mtime});
			stampsDirty = true;
		}

		// 进度文件第一行是世界标识。换了存档就从头画，避免把旧世界的进度套到新世界上。
		private void loadStamps() {
			Path directory = runtime.directory();
			if (directory == null) {
				return;
			}
			Path path = directory.resolve(STAMP_FILE);
			if (!Files.isRegularFile(path)) {
				return;
			}
			List<String> lines;
			try {
				lines = Files.readAllLines(path, StandardCharsets.UTF_8);
			} catch (IOException e) {
				SguBridge.LOGGER.warn("地图进度没能读取：{}", e.getMessage());
				return;
			}
			if (lines.isEmpty() || !lines.get(0).equals("world " + world)) {
				return;
			}
			for (int index = 1; index < lines.size(); index++) {
				String[] parts = lines.get(index).split(" ");
				if (parts.length != 3) {
					continue;
				}
				try {
					stamps.put(parts[0], new long[] {Long.parseLong(parts[1]), Long.parseLong(parts[2])});
				} catch (NumberFormatException ignored) {
					// 写坏的一行跳过，这块区域会重新画
				}
			}
		}

		private synchronized void saveStamps() {
			Path directory = runtime.directory();
			if (directory == null) {
				return;
			}
			stampsDirty = false;
			Path path = directory.resolve(STAMP_FILE);
			Path temporary = path.resolveSibling(STAMP_FILE + ".tmp");
			List<String> lines = new ArrayList<>(stamps.size() + 1);
			lines.add("world " + world);
			for (Map.Entry<String, long[]> entry : stamps.entrySet()) {
				long[] value = entry.getValue();
				lines.add(entry.getKey() + " " + value[0] + " " + value[1]);
			}
			try {
				Files.write(temporary, lines, StandardCharsets.UTF_8);
				try {
					Files.move(temporary, path, StandardCopyOption.REPLACE_EXISTING, StandardCopyOption.ATOMIC_MOVE);
				} catch (AtomicMoveNotSupportedException e) {
					Files.move(temporary, path, StandardCopyOption.REPLACE_EXISTING);
				}
			} catch (IOException e) {
				stampsDirty = true;
				SguBridge.LOGGER.warn("地图进度没能保存：{}", e.getMessage());
			}
		}

		private final class SessionListener implements WebSocket.Listener {
			private final StringBuilder incoming = new StringBuilder();
			private final CompletableFuture<Boolean> auth = new CompletableFuture<>();
			private final CompletableFuture<Void> closed = new CompletableFuture<>();
			private final AtomicLong lastSeen = new AtomicLong(System.nanoTime());
			private volatile CompletableFuture<WebSocket> authSend = CompletableFuture.completedFuture(null);
			private volatile boolean authed;

			@Override
			public void onOpen(WebSocket webSocket) {
				lastSeen.set(System.nanoTime());
				webSocket.request(1);
				JsonObject hello = new JsonObject();
				hello.addProperty("op", "auth");
				hello.addProperty("token", runtime.config().token());
				hello.addProperty("role", "map");
				authSend = webSocket.sendText(hello.toString(), true)
					.whenComplete((value, error) -> {
						if (error != null) {
							webSocket.abort();
						}
					});
			}

			@Override
			public CompletableFuture<?> onText(WebSocket webSocket, CharSequence data, boolean last) {
				lastSeen.set(System.nanoTime());
				incoming.append(data);
				if (incoming.length() > 1024 * 1024) {
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
					boolean ok = false;
					try {
						JsonObject message = JsonParser.parseString(text).getAsJsonObject();
						JsonElement op = message.get("op");
						JsonElement accepted = message.get("ok");
						ok = op != null && op.isJsonPrimitive() && "auth".equals(op.getAsString())
							&& accepted != null && accepted.isJsonPrimitive() && accepted.getAsBoolean();
					} catch (RuntimeException ignored) {
						// 不是鉴权回复，按拒绝处理
					}
					authed = ok;
					auth.complete(ok);
					return null;
				}
				acceptNeed(text);
				return null;
			}

			@Override
			public CompletableFuture<?> onBinary(WebSocket webSocket, ByteBuffer data, boolean last) {
				lastSeen.set(System.nanoTime());
				webSocket.request(1);
				return null;
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
			public CompletableFuture<?> onClose(WebSocket webSocket, int statusCode, String reason) {
				auth.complete(false);
				closed.complete(null);
				return null;
			}

			@Override
			public void onError(WebSocket webSocket, Throwable error) {
				if (alive.get()) {
					SguBridge.LOGGER.warn("地图上传异常：{}", describe(error));
				}
				auth.complete(false);
				closed.complete(null);
				webSocket.abort();
			}
		}
	}

	private static final class RegionJob {
		final String dim;
		final String name;
		final int regionX;
		final int regionZ;
		final boolean single;
		final int tileX;
		final int tileZ;
		final String inflightKey;
		final boolean stamp;

		private RegionJob(String dim, String name, int regionX, int regionZ, boolean single, int tileX, int tileZ, String inflightKey, boolean stamp) {
			this.dim = dim;
			this.name = name;
			this.regionX = regionX;
			this.regionZ = regionZ;
			this.single = single;
			this.tileX = tileX;
			this.tileZ = tileZ;
			this.inflightKey = inflightKey;
			this.stamp = stamp;
		}

		static RegionJob region(String dim, String name, int regionX, int regionZ, String key) {
			return new RegionJob(dim, name, regionX, regionZ, false, 0, 0, key, true);
		}

		static RegionJob tile(String dim, String name, int tileX, int tileZ, String key) {
			return new RegionJob(dim, name, Math.floorDiv(tileX, 2), Math.floorDiv(tileZ, 2), true, tileX, tileZ, key, false);
		}
	}

	private static final class Piece {
		final int tileX;
		final int tileZ;
		final byte[] packed;

		Piece(int tileX, int tileZ, byte[] packed) {
			this.tileX = tileX;
			this.tileZ = tileZ;
			this.packed = packed;
		}
	}

	private static final class Batch {
		final String inflightKey;
		final String stampKey;
		final long size;
		final long mtime;
		final boolean stable;
		final int chunkErrors;
		final AtomicInteger left;
		volatile boolean failed;

		Batch(String inflightKey, String stampKey, long size, long mtime, boolean stable, int chunkErrors, int count) {
			this.inflightKey = inflightKey;
			this.stampKey = stampKey;
			this.size = size;
			this.mtime = mtime;
			this.stable = stable;
			this.chunkErrors = chunkErrors;
			this.left = new AtomicInteger(count);
		}
	}

	private static final class Outbound {
		final ByteBuffer frame;
		final int bytes;
		final boolean urgent;
		final Batch batch;

		Outbound(ByteBuffer frame, boolean urgent, Batch batch) {
			this.frame = frame;
			this.bytes = frame.remaining();
			this.urgent = urgent;
			this.batch = batch;
		}
	}
}
