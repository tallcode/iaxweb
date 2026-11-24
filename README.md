# iaxweb

iaxweb 是面向 `iaxmon --nats` 的 Web 网关。它通过 Allmon3 获取节点和链路状态，通过 NATS 接收节点音频，并向浏览器提供实时状态和播放。

- **公开站**提供中继拓扑、地图、覆盖预测、实时监听和通联统计。
- **AI 值机员**可按节点启用，支持语音转写、呼号识别和公开 AI Spots。
- **管理后台**在启用持久化后提供录音回听、人工校对、标注、声纹识别和用户管理。

[快速开始](#快速开始) · [部署与升级](#部署与升级) · [AI 与记录管理](#ai-与记录管理) · [日常维护](#日常维护) · [开发与目录](#开发与目录)

## 快速开始

准备可访问的 Allmon3 和 NATS 服务，并让音频节点以 `iaxmon --nats` 发布。源码运行需要 Node.js 24 或更新版本，npm 版本以 `packageManager` 为准。使用发布镜像时，宿主机需要 Docker Compose 和部署配置。 [版本配置](package.json)

### 配置上游与节点

在仓库根目录创建配置和数据目录。已有 `.env` 时继续使用原文件。

```bash
mkdir -p config data
test -f .env || cp .env.example .env
```

在 `.env` 中填写实际服务地址和主题前缀。以下地址是示例，`NATS_SUBJECT_ROOT` 应与 iaxmon 一致。NATS 如需认证，可配置 `NATS_USERNAME` 与 `NATS_PASSWORD`，或配置 `NATS_TOKEN`。完整配置见 [.env.example](.env.example)。

```dotenv
NATS_SERVERS=nats://nats.example:4222
NATS_SUBJECT_ROOT=iaxmon.nodes
ALLMON3_BASE_URL=http://allmon.example/allmon3/
```

应用读取仓库根目录的 `.env`，进程环境变量优先。环境变量中的相对文件路径以仓库根目录为基准。修改环境变量或节点配置后，重启后端。

创建 `config/nodes.json`，将示例节点号和名称换成实际配置。节点号使用数字字符串，`TYPE` 可用 `HUB` 或 `REPEATER`。

```json
{
  "1000": {
    "NAME": "示例中心节点",
    "TYPE": "HUB",
    "AUDIO": true,
    "LINK": ["1001"]
  },
  "1001": {
    "NAME": "示例中继节点",
    "TYPE": "REPEATER",
    "GB": "156330106",
    "LOCATION": { "lat": 30.25, "lon": 120.1 },
    "LINK": ["1000"]
  }
}
```

- `AUDIO: true` 启用该节点的实时音频订阅。公开站在已启用音频的 HUB 卡片上显示播放按钮。
- `AI: true` 启用该节点的 AI 值机员，同时需要 `AUDIO: true` 和对应的 [AI 配置](#ai-与记录管理)。
- 地图优先使用 `LOCATION` 中的 WGS84 经纬度。省略 `LOCATION` 时，按 `GB` 使用县区内部中心。

### 本地启动

首次开发先构建两套前端，因为后端在启动时会加载它们的 HTML。删除 `dist` 后也需要重建一次。

```bash
npm ci
npm run build
npm run dev
```

| 服务 | 默认地址 | 单独启动 |
| --- | --- | --- |
| 公开站 | `http://localhost:5173` | `npm run dev:public` |
| 管理后台 | `http://localhost:5174/admin/` | `npm run dev:admin` |
| 后端 | `http://localhost:3000` | `npm run dev:backend` |

开发时访问 Vite 地址可使用热更新。两套 Vite 服务的代理默认指向 `localhost:3000`。修改后端 `PORT` 时，需要同步调整对应的 Vite 代理。管理后台登录需要先[启用记录管理](#记录管理与账号)。

## 部署与升级

### Docker Compose

完成[上游和节点配置](#配置上游与节点)后，在部署目录运行以下命令。需要记录管理或声纹时，先准备对应的账号配置和模型文件。

```bash
docker compose pull iaxweb
docker compose up -d iaxweb
docker compose logs -f iaxweb
```

- 默认访问 `http://localhost:8059`，管理后台为 `/admin/`。Compose 将宿主机的 `8059` 映射到容器的 `3000`。
- `./config` 以只读方式挂载到 `/app/config`，`./data` 挂载到 `/app/data`。可在 `.env` 中设置 `PUID` 和 `PGID`，确保容器能读取配置并写入数据。
- `NATS_SERVERS` 和 `ALLMON3_BASE_URL` 须填写容器可达的地址。Docker Desktop 上的宿主机服务可通过 `host.docker.internal` 访问。
- 反向代理须为 `/status` 和 `/audio/<nodeId>` 支持 WebSocket Upgrade。使用 HTTPS 时，代理应转发 `X-Forwarded-Proto`。
- `GET /healthz` 用于存活检查。返回中的 `allmon3` 表示已经生成状态快照，`nats` 表示已配置的音频节点连接状态。判断上游是否正常时，也应查看节点状态和服务日志。
- `/sitemap.xml` 列出首页拓扑 `/`、地图 `/map` 和统计 `/stats`，并由 `/robots.txt` 引用。默认从请求取得域名和协议。反向代理需保留公开域名的 `Host` 并传递实际的 `X-Forwarded-Proto`。有多个访问域名时，可用 `PUBLIC_SITE_URL` 固定站点地图和页面的规范网址。

镜像为 `ghcr.io/tallcode/iaxweb:latest`。推送到 `main` 后，发布流程会构建并推送 `latest` 和 `sha-<短 SHA>` 标签。私有镜像需要先运行 `docker login ghcr.io`。 [镜像发布工作流](.github/workflows/docker-publish.yml)

<details>
<summary>从源码构建容器</summary>

```bash
docker build -t iaxweb:local .
docker run -d --name iaxweb \
  --env-file .env \
  --user "$(id -u):$(id -g)" \
  -p 8059:3000 \
  -v "$PWD/config:/app/config:ro" \
  -v "$PWD/data:/app/data" \
  iaxweb:local
```

</details>

### 不使用容器

在已完成配置的仓库根目录执行 `npm ci`、`npm run build` 和 `npm start`。后端默认监听 `3000`，同时提供公开站和管理后台。

### 更新已有实例

1. 保留宿主机的 `.env`、`config/` 和 `data/`。拉取镜像只会更新应用，部署配置和模型由宿主机管理。
2. 启用了 LLM 的实例应将 `examples/ai/schema.json` 同步到配置目录或 `AI_LLM_SCHEMA_FILE` 指定的位置。仍在使用旧 full 提示词的实例还需换成当前的 simple 提示词。
3. 已完成迁移的 SQLite 数据库可直接继续使用。历史录音、声纹、识别结果和人工标注会保留，旧 full 字段也仍保存在原表中。恢复尚未迁移的早期备份时，需先用支持旧库迁移的版本完成升级。
4. 镜像发布完成后拉取并重建容器。调整 Compose 资源限制时，也需将更新后的 `docker-compose.yml` 同步到部署主机。

## AI 与记录管理

### 语音转写和呼号识别

为需要识别的节点同时设置 `"AUDIO": true` 和 `"AI": true`，并在 `.env` 配置 `AI_ASR_API_KEY`。只需要转写时，设置 `AI_LLM_ENABLED=false`。

启用呼号识别时，另设 `AI_LLM_API_KEY`，并在实际运行环境准备 simple 提示词和 Schema。ASR 和 LLM 的端点与模型可分别配置。 [环境变量示例](.env.example)

```bash
cp examples/ai/simple/prompt.txt config/prompt.txt
cp examples/ai/schema.json config/schema.json
```

- 模型提取原文中的自报和字母解释法证据，由程序匹配最终呼号。程序每次解析时重新读取提示词与 Schema。文件缺失、不可读或无效时跳过呼号解析，已生成的转写仍可使用。
- `AI_LLM_PUBLISH_SPOT=false` 会关闭公开 AI Spots 面板、实时发布和历史返回。该设置可与后台转写、记录和人工审核独立使用。
- 可通过 `AI_HOTWORDS_FILE` 和 `AI_BACKGROUND_FILE` 为 ASR 指定热词与背景文件。默认路径为 `config/hotwords.json` 和 `config/background.txt`，保存后下一次转写生效。 [背景示例](examples/ai/background.txt)

### 记录管理与账号

设置 `AI_PERSISTENCE_ENABLED=true`，开启 SQLite、WAV 录音保存、管理后台和公开通联统计。启用前先生成系统管理员密码哈希。

```bash
npm run hash-admin-password -- 'replace-with-your-password'
```

将哈希写入 `config/admin.json`，然后启动服务并访问 `/admin/`。修改系统管理员配置后需重启后端。

```json
{
  "users": [
    {
      "username": "admin",
      "passwordHash": "replace-with-generated-scrypt-hash"
    }
  ]
}
```

| 角色 | 权限 |
| --- | --- |
| `viewer` | 查看记录、回听录音 |
| `editor` | 在查看权限基础上，编辑未标注记录的转写和主叫、被叫呼号 |
| `admin` | 查看、编辑、标注和删除记录，手动声纹识别，管理用户 |

### 声纹识别

手动声纹识别和自动声纹补证均需要启用持久化，并在宿主机准备 ERes2NetV2 模型。

```bash
npm run download:speaker-model
```

默认模型路径为 `config/models/3dspeaker_speech_eres2netv2_sv_zh-cn_16k-common.onnx`，约 71.4 MB。自定义存放位置使用 `AI_SPEAKER_MODEL_FILE`。容器通过只读的 `config/` 挂载读取模型，更新镜像后可继续使用原文件。

| 用法 | 行为 |
| --- | --- |
| 后台手动识别 | 管理员可用一条录音查找候选呼号，参考库使用已标注录音 |
| 自动特征补证 | 设置 `AI_LLM_STAGE2_ENABLED=true`，同时启用 LLM 和持久化。程序在质量检查通过后并行提取特征，支持来源最多等待 20 秒，不增加 LLM 调用 |

部署识别流程更新时，同时更新挂载目录中的 `config/prompt.txt` 和 `config/schema.json`；仓库的 `examples/ai/` 提供配套版本。旧格式 schema 不会启动 LLM。使用 LLM 自报确认的结果记为阶段 1，仅由特征替代空自报完成确认的结果记为阶段 2。

同版本的有效声纹可复用。声纹以独立进程运行，使用 2 个 CPU 推理线程，一次处理一条最长 60 秒的完整录音。处理一分钟录音建议宿主机至少有 4 GiB 内存。仓库的 Compose 配置将应用限制在 1.5 核、2.5 GiB 内存并禁用 Swap。

<details>
<summary>匹配与诊断细节</summary>

- 声纹表使用 192 维、768 字节的向量。查询排除当前录音，并从同版本的有效已标注录音中选择参考。逐条相似度须大于 0.80。
- 每个候选呼号最多取最近 16 条参考。接口返回合成相似度 `referenceSimilarity` 及参考条数 `referenceRecordCount`。达到 5 条参考时尝试分组，组内最低相似度为 0.72，分组条数须严格大于参考总数的 20%。
- `speaker-recognition` 接口的 `measurements` 以毫秒记录各阶段耗时，未执行或未测得的阶段为 `null`。`totalMs` 涵盖排队和查询，`processTotalMs` 只涵盖计算子进程阶段。
- 实际提取超时为 60 秒，排队最多 4 项，排队时长另计。进程 RSS 上限为 2 GiB，可用内存不足时进一步降低。进程空闲 5 分钟或任务结束后 RSS 达到约 1 GiB 时回收。运行中的任务超时、取消或异常时，等旧进程退出后再继续。

</details>

## 日常维护

### 数据目录和备份

| 默认路径 | 用途 |
| --- | --- |
| `data/ai.sqlite` | 识别、人工标注和声纹 |
| `data/rec/` | WAV 录音，按采集时间的 UTC 日期存放 |
| `data/users.json`、`data/sessions.json` | 后台用户及登录会话 |
| `data/stats/speech-activity.json` | 公开通联统计缓存，按北京时间聚合，访问时刷新 |
| `data/embedding-backfill/` | 声纹补算清单、进度和备份 |
| `data/coverage/` | 可选地图覆盖预测图层 |

在装有 `sqlite3` 的宿主机执行以下命令，可在服务运行时备份 `data/ai.sqlite`。备份默认输出到 `data/backups/`，第二个参数可指定输出目录。脚本以传入目录下的 `ai.sqlite` 为源，录音和部署配置需单独备份。

```bash
./scripts/backup-sqlite.sh ./data
```

### 补算已标注录音的声纹

```bash
npm run backfill:speaker -- --dry-run
npm run backfill:speaker
npm run backfill:speaker -- --help
```

试跑会保存候选清单，正式执行前会备份数据库并保存进度。默认补算已标注且声纹缺失或版本过旧的记录，当前版本已有有效声纹和在线待处理任务继续保留。中断后运行相同命令即可续跑，支持 `--limit`、`--delay-ms` 和重试选项。质量门禁调整后，已保存的质量结论继续保留。手动识别时可重新检查 `rejected`、`unknown` 和 `skip` 的录音。

容器部署使用 `docker compose exec iaxweb npm run backfill:speaker -- --dry-run` 试跑，去掉 `-- --dry-run` 即可执行补算。

### 更新地图覆盖预测

目前地图支持四个图层，从 `data/coverage/` 按需加载。原有仿真半径均为 300 km。

| 中继 | 频率 | 功率 | 天线离地高度 |
| --- | --- | --- | --- |
| BR5AI | 145.4 MHz | 25 W | 400 m |
| BR5BB | 145.48 MHz | 10 W | 526 m |
| BR5AF | 145.52 MHz | 25 W | 100 m |
| BR5AO | 145.22 MHz | 25 W | 70 m |

从站点弹窗导出 GeoJSON，再在宿主机打包。脚本保留 dBm 阈值、颜色和多边形孔洞，压缩后的文件保存到 `data/coverage/<呼号>.geojson.gz`。建议保留原始导出文件。 [Meshtastic Site Planner](https://site.meshtastic.org/)

```bash
node scripts/pack-coverage.mjs BR5AI /path/to/coverage.geojson
```

新增地图开关时也要更新前端的呼号列表并重新构建。`/api/coverage/<呼号>.geojson` 直接发送 gzip 文件，客户端需通过 `Accept-Encoding` 接受 gzip，响应可缓存 30 天。 [地图图层列表](apps/public/src/pages/MapPage.vue#L26)

## 开发与目录

| 路径 | 职责 |
| --- | --- |
| `apps/backend/` | Fastify HTTP 与 WebSocket、上游网关、AI 识别和 SQLite 持久化 |
| `apps/public/` | Vue / Vite 公开站、拓扑、地图、实时播放和统计 |
| `apps/admin/` | Vue / Vite 管理后台 |
| `packages/contracts/` | 前后端共享类型和接口 Schema |
| `packages/audio-protocol/` | 公开站和后端共享的实时音频帧解析与 PCMU 解码 |
| `examples/ai/`、`scripts/` | AI 示例配置、备份和维护工具 |
| `config/`、`data/` | 部署配置与运行数据，随宿主机管理 |

```bash
npm run lint
npm run typecheck
npm run build
```

构建产物位于 `apps/public/dist` 和 `apps/admin/dist`。本地检查约定见 [AGENTS.md](AGENTS.md)。

| 调试命令 | 用途 |
| --- | --- |
| `npm run phonetic-corrector-test -- "待检查的文本"` | 查看音素纠错结果 |
| `npm run llm-parse-test -- "待检查的文本"` | 使用已配置的模型接口调试呼号提取 |

## 许可证

本项目采用 GNU GPL v2 或后续版本（GPL-2.0-or-later）。第三方组件及数据保留各自的许可证。 [LICENSE](LICENSE)
