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
  prompt.txt         AI 提取提示词（启用 LLM 时必需）
  schema.json        AI 识别共用的输出 Schema
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
    "GB": "156330106",
    "LOCATION": { "lat": 30.25, "lon": 120.1 },
    "LINK": ["1000"],
    "AUDIO": true
  }
}
```

中继的 `LOCATION` 可选，填写 WGS84 经纬度（`lat` 为纬度，`lon` 为经度）。地图优先使用经纬度定位，未配置 `LOCATION` 时按 `GB` 使用县区内部中心。

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

### 地图覆盖预测

地图页可分别开启 BR5AI、BR5BB、BR5AF 和 BR5AO 的预测覆盖图层，按需从 `data/coverage/` 加载对应文件。仿真半径均设为 300 km。

| 中继 | 频率 | 功率 | 天线离地高度 |
| --- | --- | --- | --- |
| BR5AI | 145.4 MHz | 25 W | 400 m |
| BR5BB | 145.48 MHz | 10 W | 526 m |
| BR5AF | 145.52 MHz | 25 W | 100 m |
| BR5AO | 145.22 MHz | 25 W | 70 m |

更新或增加中继图层时，先从 [Meshtastic Site Planner](https://site.meshtastic.org/) 的站点弹窗导出 GeoJSON，再运行以下命令。将 `BR5AI` 替换成对应中继名即可生成同名文件。

```bash
node scripts/pack-coverage.mjs BR5AI /path/to/coverage.geojson
```

脚本保留每档的 dBm 阈值、原始颜色、多边形和孔洞。经纬度舍入到小数点后四位，并清理重复的连续点和线段上的共线中间点。舍入后会塌缩或反转的环保留原精度。最后将紧凑 JSON 用 gzip 最高压缩级别打包，并原子替换 `data/coverage/<中继名>.geojson.gz`。保留原始导出，以便重做。

覆盖文件随部署主机的 `data/` 目录管理，由 Docker Compose 挂载到容器。`/api/coverage/BR5AI.geojson` 直接发送磁盘上的 gzip 字节，客户端须在 `Accept-Encoding` 声明接受 gzip，否则返回 `406`。响应缓存有效期为 30 天。同名文件替换后，已缓存的客户端可能继续使用旧版本直至过期。

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
cp examples/ai/schema.json config/schema.json
```

`examples/ai/full/prompt.txt` 提供包含文本整理和风险评级的完整提示词，使用时设置 `AI_LLM_ANALYSIS_ENABLED=true`。

`config/prompt.txt` 只包含一份提取提示词，无需分段。每次调用前重新读取，编辑后无需重启。提示词或 Schema 缺失、不可读、无效时跳过识别。

已有部署升级时须同时替换 `config/prompt.txt` 和 `config/schema.json`。模型只输出自报与解释法的四个提取字段；最终呼号由程序匹配，二阶段不再调用模型。完整模式继续输出 `message` 和 `risk`。

ASR 可选配置包括 `config/hotwords.json`（热词）和 `config/background.txt`（背景文本）。可将 [ASR 背景示例](examples/ai/background.txt) 复制为 `config/background.txt`，保存后下一次转写即生效。

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
| `data/stats/speech-activity.json` | 前台语音活动统计缓存，访问时按北京时间刷新 |
| `data/embedding-backfill/` | 声纹补算进度及备份 |

### 声纹模型

使用声纹功能前，在宿主机准备一次模型：

```bash
npm run download:speaker-model
```

模型为 ERes2NetV2，保存在 `config/models/3dspeaker_speech_eres2netv2_sv_zh-cn_16k-common.onnx`，约 71.4 MB；已有正确文件时跳过下载。也可以将同一模型文件从开发机复制到服务器。自定义路径使用 `AI_SPEAKER_MODEL_FILE`，升级时需同步更新旧路径覆盖。

Docker 不下载、不打包模型，通过 `config/` 的只读挂载使用该文件。模型随配置独立保存，更新应用镜像无需重新下载。

启用 `AI_LLM_STAGE2_ENABLED=true` 可以在 ASR 时并行计算录音特征，在文字识别留空时尝试第二阶段补证。该开关默认关闭，需要同时启用 `AI_LLM_ENABLED` 和 `AI_PERSISTENCE_ENABLED`。自动特征匹配的等待上限为 20 秒，超时后继续使用文字识别结果。两阶段识别成功后均按 `AI_LLM_PUBLISH_SPOT` 发布。

自动和手动查询生成的有效特征都缓存到 `ai_segment_embeddings`。后续查询复用同版本向量，匹配范围始终是已标注录音。

匹配接口保留逐条命中的统计，并为每个候选呼号返回 `referenceSimilarity`（合成相似度）和 `referenceRecordCount`（参与合成数量）。参考来自该呼号最近最多 16 条已标注、当前模型版本的有效特征，排除查询录音自身。达到 5 条参考时，`referenceGroups` 返回完全链接分组后的合成分数和条数，组内最低相似度为 0.72，保留条数严格大于参考总数 20% 的组。参考不足 5 条或无合格组时返回空数组。合成使用 `addMulti`，分数供手动对照。`measurements.referenceLookupMs` 记录参考查询耗时，`referenceMatchMs` 包含合成比对任务的排队与执行耗时。

`speaker-recognition` 响应的 `measurements` 返回分阶段耗时，单位为毫秒。未执行或未取得计时的阶段为 `null`；复用模型时启动、校验和加载耗时为 `null`，进程未回收时退出耗时为 `null`。`processTotalMs` 是本条录音在计算子进程中的处理耗时（包含本次启动或回收），`totalMs` 还包含排队和数据库查询，两者与内部阶段存在包含关系，不应重复相加。测量数据不写入日志或数据库。

声纹采用独立常驻计算进程，单任务、2 个推理线程，首次需要模型时加载，后续录音复用模型。支持最长 60 秒录音，子进程最多 2 GiB RSS（可用内存不足时进一步降低），每条实际提取超时为 60 秒。空闲 5 分钟或任务完成后 RSS 达到 1 GiB（低内存环境进一步降低）时回收，不按任务条数或进程存活时间回收；预计需要至少 1 GiB 内存的长录音先回收旧进程再计算，防止旧内存池叠加。超时、运行中取消或异常会终止进程，等待退出后才能处理下一条。最多排队等待 4 条，按提交顺序处理，排队时间不计入提取超时；取消等待请求仅移除该任务。后台每轮只处理一条，完成后间隔 5 秒，手动队列繁忙时暂缓重算。内存不足会暂停并保留待处理记录。提取使用完整录音，不分段、不截断，已有有效向量无需重算。

升级后自动重试之前因 20 秒或 640 MiB 限制排除、且当前仍已标注的不超过 60 秒录音；已有有效声纹和干扰检查结论保留。

一分钟整段声纹提取建议使用至少 4 GiB 内存的宿主机。默认 Compose 限制应用为 1.5 核、2.5 GiB 内存，并禁止容器使用 Swap。已有部署需同步更新 `docker-compose.yml` 的资源限制并重建容器，单独拉取镜像不会更新这些配置。

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
| `npm run llm-parse-test -- "待检查的文本"` | LLM 解析，会调用配置的模型接口 |

## 许可证

本项目采用 **GNU GPL v2 或后续版本（GPL-2.0-or-later）**，见 [LICENSE](LICENSE)。第三方组件及数据保留各自的许可证。
