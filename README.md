# iaxweb

面向 `iaxmon --nats` 的 Web 网关，提供节点拓扑、音频播放和记录管理。项目使用 npm workspaces，后端为 Node.js / TypeScript，前端为 Vue / Vite。

## 环境要求

- Node.js 24 或更新版本；npm 版本见 [package.json](package.json) 的 `packageManager`。
- 可访问的 NATS 和 Allmon3 服务。
- Docker Compose：用于容器部署。
- SQLite 命令行工具：仅数据库备份脚本需要。

## 目录结构

```text
apps/
  backend/           HTTP、WebSocket 和后台服务
  public/            公开页面
  admin/             管理后台
packages/contracts/  前后端共享类型与接口 schema
examples/ai/         AI 提示词和输出 schema 示例
scripts/             模型下载、数据库备份等工具
config/              部署配置，不提交到 Git
  nodes.json         节点配置
  admin.json         系统管理员账号
  prompt.txt         AI 提示词（可选）
  schema.json        AI 输出 schema（可选）
  models/            声纹模型（可选）
data/                数据库、录音、用户和会话等运行数据，不提交到 Git
```

## 本地开发

在项目根目录执行：

```bash
npm ci
cp .env.example .env
mkdir -p config data
```

修改 `.env` 中的服务地址；以下地址为占位示例：

```dotenv
NATS_SERVERS=nats://nats.example:4222
NATS_SUBJECT_ROOT=iaxmon.nodes
ALLMON3_BASE_URL=http://allmon.example/allmon3/
```

完整配置项见 [.env.example](.env.example)。服务会读取项目根目录的 `.env`，进程环境变量优先。相对文件路径均以项目根目录为基准。

创建 `config/nodes.json`，节点号和名称按实际环境替换：

```json
{
  "1000": {
    "NAME": "示例中心节点",
    "TYPE": "HUB",
    "LINK": ["1001"]
  },
  "1001": {
    "NAME": "示例中继节点",
    "TYPE": "REPEATER",
    "LINK": ["1000"],
    "AUDIO": true
  }
}
```

启动开发服务：

```bash
npm run dev
```

| 服务 | 地址 | 单独启动 |
| --- | --- | --- |
| 后端 | `http://localhost:3000` | `npm run dev:backend` |
| 公开页面 | `http://localhost:5173` | `npm run dev:public` |
| 管理后台 | `http://localhost:5174/admin/` | `npm run dev:admin` |

Vite 开发服务器已配置后端代理。环境变量和节点配置修改后需重启服务。

## 可选功能配置

### AI 识别

在需要识别的节点中同时设置 `"AUDIO": true` 和 `"AI": true`，并配置 `.env`：

```dotenv
AI_ASR_API_KEY=replace-with-asr-key
AI_LLM_API_KEY=replace-with-llm-key
```

ASR 和 LLM 的端点、模型可分别配置；只使用语音转写时设置 `AI_LLM_ENABLED=false`。

启用 LLM 时，选择一套示例复制到 `config/`：

```bash
cp examples/ai/simple/prompt.txt config/prompt.txt
cp examples/ai/simple/schema.json config/schema.json
```

`examples/ai/full/` 提供包含文本整理和风险评级的完整示例。

可选文件：`config/hotwords.json` 为热词配置，`config/background.txt` 为背景文本，`config/callsigns.txt` 供离线呼号检索工具使用。

### 记录管理

在 `.env` 中设置 `AI_PERSISTENCE_ENABLED=true`，启用 SQLite、录音保存和管理后台。

先生成管理员密码哈希：

```bash
npm run hash-admin-password -- 'replace-with-your-password'
```

将输出的哈希填入 `config/admin.json`：

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

登录 `/admin/` 后，可在用户管理页面创建其他账号，角色支持 `admin`、`editor` 和 `viewer`。修改系统管理员配置后需重启服务。

默认运行数据：

| 路径 | 内容 |
| --- | --- |
| `data/ai.sqlite` | 识别记录及声纹 |
| `data/rec/` | WAV 录音，按 UTC 日期分目录 |
| `data/users.json` | 普通用户账号 |
| `data/sessions.json` | 登录会话 |
| `data/embedding-backfill/` | 声纹补算进度及备份 |

### 声纹模型

使用声纹功能前，在宿主机准备一次模型：

```bash
npm run download:speaker-model
```

模型为 ERes2NetV2，保存在 `config/models/3dspeaker_speech_eres2netv2_sv_zh-cn_16k-common.onnx`，约 71.4 MB；已有正确文件时跳过下载。也可以将同一模型文件从开发机复制到服务器。自定义路径使用 `AI_SPEAKER_MODEL_FILE`，升级时需同步更新旧路径覆盖。

Docker 不下载、不打包模型，通过 `config/` 的只读挂载使用该文件。模型随配置独立保存，更新应用镜像无需重新下载。

管理后台的声纹匹配目前是管理员手动测试功能；已标注录音会自动计算并保存声纹，测试查询不入库。

声纹采用单任务、单线程、每条独立进程运行，任务退出后释放模型内存。支持最长 60 秒录音，子进程最多 2 GiB RSS（可用内存不足时进一步降低），每条实际提取超时为 60 秒。最多排队等待 4 条，按提交顺序处理，排队时间不计入提取超时；取消请求会移除等待任务。后台每轮只处理一条，完成后间隔 5 秒，手动队列繁忙时暂缓重算。内存不足会暂停并保留待处理记录。提取使用完整录音，不分段、不截断，已有有效向量无需重算。

升级后自动重试之前因 20 秒或 640 MiB 限制排除、且当前仍已标注的不超过 60 秒录音；已有有效声纹和干扰检查结论保留。

一分钟整段声纹提取建议使用至少 4 GiB 内存的宿主机。默认 Compose 限制应用为 1 核、2.5 GiB 内存，并禁止容器使用 Swap。已有部署需在宿主机内存升级后同步更新 `docker-compose.yml` 的资源限制，单独拉取镜像不会更新这些配置。

旧数据库首次启动时，在事务内清空旧声纹并升级为固定 192 维、768 字节的声纹表；升级前请自行备份数据库。后台分批重算已标注录音，期间只检索已完成的新声纹；录音、识别结果及人工标注保留。后续重启不会重复清空，无需手动删除数据。

## 检查与构建

```bash
npm run typecheck
npm run lint
npm run build
```

构建产物位于 `apps/public/dist` 和 `apps/admin/dist`。本地检查约定见 [AGENTS.md](AGENTS.md)。

直接运行生产服务：

```bash
npm start
```

后端默认监听 `3000`，同时托管公开页面 `/` 和管理后台 `/admin/`。

## Docker 部署

先准备 `.env`、`config/` 和 `data/`；启用记录管理时需提供 `config/admin.json`，使用声纹时需准备模型文件。

使用仓库发布的镜像部署：

```bash
docker compose pull iaxweb
docker compose up -d iaxweb
docker compose logs -f iaxweb
```

访问 `http://localhost:8059`，管理后台为 `/admin/`。

Compose 使用 `ghcr.io/tallcode/iaxweb:latest`，挂载 `./config:/app/config:ro` 和 `./data:/app/data`。根据宿主机目录权限在 `.env` 设置 `PUID`、`PGID`，确保配置可读、数据目录可写。

`NATS_SERVERS` 和 `ALLMON3_BASE_URL` 必须是容器可达地址。Docker Desktop 访问宿主机可使用 `host.docker.internal`。

自行构建和运行：

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

停止服务使用 `docker compose stop` 或 `docker compose down`。

推送到 `main` 后，[GitHub Actions](.github/workflows/docker-publish.yml) 自动构建并发布 `latest` 和 `sha-<commit>` 镜像标签。私有镜像需先执行 `docker login ghcr.io`。

反向代理需支持 `/audio/<nodeId>` 和 `/status` 的 WebSocket Upgrade；HTTPS 代理应转发 `X-Forwarded-Proto`。存活检查接口为 `GET /healthz`。

## 维护命令

### 数据库备份

在安装了 `sqlite3` 的宿主机执行：

```bash
./scripts/backup-sqlite.sh ./data
```

默认输出到 `data/backups/`；第二个参数可指定备份目录。脚本只备份数据库，录音和配置需另外备份。

### 已标注录音声纹补算

```bash
npm run backfill:speaker -- --dry-run
npm run backfill:speaker
npm run backfill:speaker -- --help
```

只处理已标注录音缺失或旧版本的声纹，自动备份并保存进度；当前版本已有声纹及在线待处理任务不覆盖。中断后再次执行相同命令即可续跑，无需指定任务目录。可用 `--limit`、`--delay-ms` 控制处理数量和间隔。

容器中使用：

```bash
docker compose exec iaxweb npm run backfill:speaker -- --dry-run
docker compose exec iaxweb npm run backfill:speaker
```

### 手动调试工具

| 命令 | 用途 |
| --- | --- |
| `npm run phonetic-corrector-test -- "待检查的文本"` | 音素纠错 |
| `npm run callsign-match-test -- "待检查的文本"` | 离线呼号检索 |
| `npm run llm-parse-test -- "待检查的文本"` | LLM 解析，会调用配置的模型接口 |

## 许可证

本项目采用 **GNU GPL v2 或后续版本（GPL-2.0-or-later）**，见 [LICENSE](LICENSE)。第三方组件及数据保留各自的许可证。
