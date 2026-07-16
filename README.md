# iaxweb

`iaxmon --nats` 的轻量 WebSocket 网关和浏览器播放器。

- Node.js + TypeScript，通过 `tsx` 直接运行
- Core NATS 普通订阅（不使用 queue group）
- 原生 HTTP 与 WebSocket 服务
- 原生 HTML、CSS 和 JavaScript，无前端框架
- 浏览器解码 8 kHz 单声道 G.711 μ-law，并按媒体时间戳提供 100 ms 抖动缓冲

## 配置

复制示例配置并按实际环境修改：

```bash
cp .env.example .env
```

服务启动时通过 `dotenv` 自动读取项目根目录的 `.env`。systemd、Docker 或进程管理器直接提供的环境变量优先级更高，不会被 `.env` 覆盖。

| 环境变量 | 默认值 | 说明 |
|---|---|---|
| `HOST` | `0.0.0.0` | HTTP 监听地址 |
| `PORT` | `3000` | HTTP 监听端口 |
| `NATS_SERVERS` | `nats://127.0.0.1:4222` | 逗号分隔的集群入口 |
| `NATS_SUBJECT_PREFIX` | `iaxmon.nodes.1999` | 与 iaxmon 配置一致的 subject 根 |
| `NATS_USERNAME` / `NATS_PASSWORD` | 未设置 | 用户名密码认证，必须一起配置 |
| `NATS_TOKEN` | 未设置 | Token 认证，不能与用户名密码共用 |
| `ALLMON3_BASE_URL` | `http://44.27.31.33/allmon3/` | Allmon3 根地址，必须以 HTTP(S) 访问 |
| `ALLMON3_REFRESH_INTERVAL_MS` | `30000` | 刷新节点列表、名称和端口的间隔 |
| `ALLMON3_REQUEST_TIMEOUT_MS` | `10000` | Allmon3 HTTP 请求超时 |

## 运行

```bash
npm install
npm run dev
```

打开 `http://localhost:3000/audio.html`，点击“播放”后页面会连接同源的 `/audio` WebSocket；再次点击“停止”会关闭 WebSocket 和音频上下文。

打开 `http://localhost:3000` 查看实时节点拓扑；`/map` 仍作为兼容入口。节点展示 nodeId、名称、在线状态、本地/远程/系统发射状态以及本进程观察到的最近一次发射时间。

根目录的 `nodes.json` 是地图的静态节点与链路配置。服务启动时会立即根据该文件生成默认离线状态，无需等待 Allmon3 返回；后续实时数据逐项覆盖默认值。`TYPE` 支持 `HUB` 和 `REPEATER`，`NAME` 保存节点短名称，`LINK` 声明允许显示的拓扑边，`FREQ` 保存中继频率信息；HUB 配置 `AUDIO: true` 时，地图节点会显示音频播放控件。

生产环境：

```bash
npm start
```

反向代理需要允许 `/audio` 和 `/status` 的 WebSocket Upgrade。`GET /healthz` 可用于存活检查。

## Docker

镜像基于 `node:24-alpine` 多阶段构建，只安装生产依赖，以非 root 用户 `node` 运行，内置 `/healthz` 健康检查，并通过 `tini` 保证 `SIGTERM` 能触发优雅关闭。

```bash
docker build -t iaxweb .

docker run --rm -p 3000:3000 \
  -e NATS_SERVERS=nats://nats.example:4222 \
  -e NATS_SUBJECT_PREFIX=iaxmon.nodes.1999 \
  iaxweb
```

配置全部通过环境变量注入（`-e` 或 `--env-file`），镜像内不包含 `.env`。容器默认监听 `0.0.0.0:3000`，可用 `-e PORT=` 调整。

也可用 Compose，宿主机端口映射为 `8059`：

```bash
docker compose up -d
```

打开 `http://localhost:8059`。`docker-compose.yml` 使用远程镜像 `ghcr.io/tallcode/iaxweb:latest`（见下方 CI），并会自动读取同目录 `.env` 做变量替换，因此 `NATS_SERVERS` 必须填**容器内可达**的地址——不要用 `127.0.0.1`（那是容器自身）。Docker Desktop 下访问宿主机的 NATS 用 `host.docker.internal`，生产环境直接填 NATS 集群地址。

## 镜像发布（GitHub Actions）

`.github/workflows/docker-publish.yml` 为**手动触发**（Actions 页面点击 “Run workflow”），构建镜像并推送到 GitHub Packages：

```
ghcr.io/tallcode/iaxweb:latest
ghcr.io/tallcode/iaxweb:sha-<commit>
```

首次发布后，包默认是私有的：`docker compose up` 拉取前需要 `docker login ghcr.io`，或在 GitHub 的 Package 设置里把可见性改为 Public。

## WebSocket 数据

### `/audio`

网关直接把 `<subject_prefix>.audio` 的 NATS 二进制 payload 转发为 WebSocket 二进制消息，把 `<subject_prefix>.events` 以及当前状态快照转发为文本 JSON。浏览器依据 iaxmon `NATS.md` 中的版本、类型、时间戳和 PCMU payload 解码播放。

每个网关进程各自订阅完整 NATS 流，不使用 queue group；同一进程内的所有浏览器共享该订阅。慢速浏览器的待发送数据超过 4 KiB 时，网关会丢弃新音频帧，避免积压陈旧实时音频。网关与 NATS 断开时会向浏览器发送离线状态，重连后重新请求状态快照。

### `/status`

网关从 Allmon3 的节点列表、名称覆盖、节点端口和状态 WebSocket 聚合完整状态。消息是以节点号为 key 的 JSON：

```json
{
  "1900": {
    "ME": 1900,
    "DESC": "浙江省业余无线电协会链路HUB",
    "RXKEYED": false,
    "TXKEYED": false,
    "CONNS": {}
  }
}
```

首次收齐全部节点详情后发送一次。之后只有收发状态、PTT、连接、名称或节点列表等实际状态发生变化时才向所有客户端发送完整 JSON；`UPTIME`、`RELOADTIME`、`CTIME`、`SSK`、`SSU` 等持续递增的计时字段不会单独触发消息。新连接的客户端会立即收到当前完整快照。每次广播同样会向服务端控制台输出一行 JSON。

每个节点还包含网关派生字段 `TX_SOURCE`（`local`、`remote`、`system` 或 `null`）和 `LAST_TX_AT`（ISO 8601 时间或 `null`）。最近发射时间保存在当前网关进程内；进程启动前的历史发射无法从 Allmon3 状态协议中恢复。

地图只绘制 `nodes.json` 的 `LINK` 中声明的链路：Allmon3 `CONNS` 显示已建立连接时使用实线，否则使用虚线；未出现在 `LINK` 中的动态连接不绘制。HUB 使用独立样式并隐藏发射状态与最近发射时间，中继节点保持完整发射信息。
