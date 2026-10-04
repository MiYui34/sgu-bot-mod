# SGU 机器人与网页地图

两件程序配合使用：Fabric 模组跑在 Minecraft 26.1.2 服务器里，Node 服务负责 QQ 机器人和网页俯视图。

## 模组

需要 Java 25 和 Gradle 9.4 以上。在 `mod` 目录执行：

```
gradle build
```

把 `build/libs/sgu-bridge-1.0.0.jar` 放进 `mods`，同时安装 Fabric API 和 Carpet 26.1。第一次启动会在 `config/sgu-bridge/` 生成：

- `config.json`：本机端口和共享密钥
- `command-allowlist.txt`：远程指令白名单，默认只有 `list`
- `records.json`：假人、下线和死亡记录

接口只监听 `127.0.0.1`。下线假人走单独接口，不会经过白名单；其它远程指令必须命中白名单。

## 机器人与地图

在 `service` 目录复制 `.env.example` 为 `.env`，填入 QQ 开放平台的 `APP_ID`、`APP_SECRET`，以及模组 `config.json` 里的 token。世界目录默认是 `/server/world`，地图读取：

- `dimensions/minecraft/overworld/region`
- `dimensions/minecraft/the_nether/region`
- `dimensions/minecraft/the_end/region`

```
npm install
npm start
```

网页在 `http://127.0.0.1:8880/`。指令面板里的地图链接必须是 `https://` 开头，所以 `MAP_PUBLIC_URL` 要写成公网地址。`ALLOWED_GROUP_OPENIDS` 为空时响应所有群，日志里会打印群 OpenID。

群里 `@机器人` 后可用：`假人`、`下线`、`下线坐标 玩家名`、`死亡 玩家名`、`执行 指令`、`地图`。`下线` 和 `执行` 只接受群主或管理员。
