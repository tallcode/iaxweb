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

## 运行

```bash
npm install
npm run dev
```

打开 `http://localhost:3000`，点击“播放”后页面会连接同源的 `/audio` WebSocket；再次点击“停止”会关闭 WebSocket 和音频上下文。

生产环境：

```bash
npm start
```

反向代理需要允许 `/audio` 的 WebSocket Upgrade。`GET /healthz` 可用于存活检查。

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

网关直接把 `<subject_prefix>.audio` 的 NATS 二进制 payload 转发为 WebSocket 二进制消息，把 `<subject_prefix>.events` 以及当前状态快照转发为文本 JSON。浏览器依据 iaxmon `NATS.md` 中的版本、类型、时间戳和 PCMU payload 解码播放。

每个网关进程各自订阅完整 NATS 流，不使用 queue group；同一进程内的所有浏览器共享该订阅。慢速浏览器的待发送数据超过 4 KiB 时，网关会丢弃新音频帧，避免积压陈旧实时音频。网关与 NATS 断开时会向浏览器发送离线状态，重连后重新请求状态快照。
