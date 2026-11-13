# iaxweb

`iaxmon --nats` 的轻量 WebSocket 网关和浏览器播放器。

- npm workspaces monorepo，前后端独立开发、统一构建
- 后端使用 Node.js + TypeScript，通过 `tsx` 直接运行
- Core NATS 普通订阅（不使用 queue group）
- Fastify HTTP 服务，WebSocket 由 `@fastify/websocket` 接管
- 前端使用 Vue、Vite、Pinia、Vue Router、TypeScript 和 Tailwind CSS
- 浏览器解码 8 kHz 单声道 G.711 μ-law，并按媒体时间戳提供 100 ms 抖动缓冲

## 项目结构

```text
apps/backend/       HTTP 入口，以及 admin、AI、Allmon3、gateway 等后端模块
apps/public/        公开拓扑 Vue 应用
apps/admin/         独立管理后台 Vue 应用
packages/contracts/ 前后端共享的 API 和 WebSocket TypeScript 类型
config/             节点定义，以及可热更新的 AI 提示词、schema、热词及呼号配置
data/               SQLite、录音及其他可写运行数据
```

根目录使用 `@antfu/eslint-config` 统一检查 TypeScript、Vue、CSS、HTML 和 JSON。

## 配置

复制示例配置并按实际环境修改：

```bash
cp .env.example .env
```

服务启动时通过 `dotenv` 自动读取项目根目录的 `.env`。systemd、Docker 或进程管理器直接提供的环境变量优先级更高，不会被 `.env` 覆盖。Compose 也通过 `env_file` 将同一个 `.env` 注入容器，因此本机运行和容器部署共用一套变量名与默认路径。

| 环境变量 | 默认值 | 说明 |
|---|---|---|
| `HOST` | `0.0.0.0` | HTTP 监听地址 |
| `PORT` | `3000` | HTTP 监听端口 |
| `NATS_SERVERS` | `nats://127.0.0.1:4222` | 逗号分隔的集群入口 |
| `NATS_SUBJECT_ROOT` | `iaxmon.nodes` | 与 iaxmon `nats.subject_root` 一致 |
| `NATS_USERNAME` / `NATS_PASSWORD` | 未设置 | 用户名密码认证，必须一起配置 |
| `NATS_TOKEN` | 未设置 | Token 认证，不能与用户名密码共用 |
| `ALLMON3_BASE_URL` | `http://172.16.211.199/allmon3/` | Allmon3 根地址，必须以 HTTP(S) 访问 |
| `ALLMON3_REFRESH_INTERVAL_MS` | `30000` | 刷新节点列表、名称和端口的间隔 |
| `ALLMON3_REQUEST_TIMEOUT_MS` | `10000` | Allmon3 HTTP 请求超时 |

旧版 `NATS_SUBJECT_PREFIX` 是包含单个节点 ID 的完整前缀，无法无歧义地迁移为多节点根。
升级时必须删除该变量并设置 `NATS_SUBJECT_ROOT`；服务检测到旧变量会直接报错，避免静默订阅错误 subject。

## AI 值机员

AI 值机员监听节点音频，按发射分段（iaxmon 的 `start`/`stop` 事件），把语音段（冷启动 ≥5 秒、热启动 ≥2 秒，最长 2 分钟）送阿里云百炼语音识别（Qwen-Audio-3.1-ASR-Flash 同步接口），识别结果输出到控制台。

在 `config/nodes.json` 中为节点添加 `"AI": true` 启用（该节点必须同时 `"AUDIO": true`），并在 `.env` 设置 `AI_ASR_API_KEY`；LLM 后处理另用 `AI_LLM_API_KEY` 配置（可设 `AI_LLM_ENABLED=false` 关闭）：

```json
{
  "1900": {
    "NAME": "浙江HUB",
    "TYPE": "HUB",
    "AUDIO": true,
    "AI": true
  }
}
```

AI 按节点独立启用，与网关其余功能互不影响；未启用的节点零开销。启用后 AI 计为 1 个 listener，即使没有浏览器收听，该节点的 IAX 呼叫也会保持。

识别规则：

- 冷启动（`AI_ACTIVITY_WINDOW_MS` 内没有过语音，通常是首次呼叫）：时长不足 `AI_COLD_MIN_SEGMENT_MS`（默认 5 秒）的段丢弃；
- 热启动（窗口内有过语音，连续对话中）：时长不足 `AI_HOT_MIN_SEGMENT_MS`（默认 2 秒）的段丢弃；
- "有过语音" 指达到冷启动阈值（默认 5 秒）的发射；被丢弃的短段不算活动，不会触发热启动；
- 时长以 iaxmon `stop` 事件的 `duration_ms` 为准；
- 超过 `AI_MAX_SEGMENT_MS`（默认 2 分钟）的段在低能量点切分为不超过 2 分钟的块依次识别；
- 最近 `AI_CONTEXT_WINDOW_MS`（默认 5 分钟）内的识别结果作为下一次识别的上下文（背景文本与历史识别合计按接口限制截断到 400 字以内）；长时间无语音后的第一段不带历史识别上下文。

配置文件每次识别前重新读取，保存后立即生效，无需重启：

- `config/hotwords.json`：即时热词，格式 `{"词": 权重}`，权重 1~5（或 50 超热词）。适合放呼号、Q 简语、值机常用词；
- `config/background.txt`：背景文本（400 字以内），如网名称、NCS、流程说明。

LLM 后处理：每条识别结果再调用文本模型，对识别文本做结构化解析。ASR 与 LLM 的 Key、端点和模型完全独立，LLM 可以换成任意 OpenAI 兼容供应商（例如 DeepSeek、OpenAI），只需配置 `AI_LLM_BASE_URL`/`AI_LLM_API_KEY`/`AI_LLM_MODEL`，不影响语音识别。调用时附带最近 `AI_CONTEXT_WINDOW_MS` 内的解析历史作为对话上下文。输出按 schema 文件严格校验，不合规记警告。`AI_LLM_ENABLED=false` 可关闭：

默认只进行实时识别，不持久化数据。设 `AI_PERSISTENCE_ENABLED=true` 后，识别成功的音频段会写入 SQLite（默认 `data/ai.sqlite`），并保存原始 WAV 到 `data/rec/YYYYMMDD/<segmentId>.wav`（按 UTC 日期分目录，便于按天清理）。ASR 完成后立即写入原始文本和录音，LLM 成功后更新同一行的 `revise`、`callsign` 和 `risk` 结果；LLM 失败不会丢失 ASR 数据。表中同时预留 `manual_callsign`、`manual_risk_level`、`manual_note` 三个人工复核字段。读取最终呼号和风险等级时使用 `ai_segments_effective` 视图，其中人工复核值优先，AI 原始结果保持不变。可通过 `AI_DATABASE_FILE` 和 `AI_RECORDINGS_DIR` 指定位置。

`config/` 和整个 `data/` 目录均被 Git 与 Docker 构建上下文忽略。Compose 将 `./config` 只读挂载到 `/app/config`，其中的节点定义、提示词、schema、热词、背景文本、呼号表和管理员账号由宿主机维护；容器进程不能改写这些配置。`./data` 则以可写方式挂载到 `/app/data`，保存 SQLite、WAL、录音和持久化的管理会话。请把部署用户的 UID/GID 配置为 `PUID`/`PGID`（默认 `1000:1000`），确保 `data/` 可读写且 `config/` 可读。

### SQLite 备份

可在宿主机上、服务运行期间创建数据库的一致性备份（需要宿主机安装 `sqlite3`）：

```bash
# 默认写入 /srv/iaxweb/data/backups/
./scripts/backup-sqlite.sh /srv/iaxweb/data

# 指定独立备份目录
./scripts/backup-sqlite.sh /srv/iaxweb/data /srv/backups/iaxweb
```

脚本使用 SQLite 的 `.backup`，会生成单个独立的 `.sqlite` 文件并执行完整性检查；不需要复制 `-wal` 或 `-shm`。它只备份数据库，不含 `data/rec/` 录音、`sessions.json` 或其他运行数据。

提示词与输出 schema 每次调用前重新读取。仓库提供两套示例：

- 简化版：`examples/ai/simple/`，识别当前说话人呼号；
- 完整版：`examples/ai/full/`，同时输出规范化 `message` 和 `risk`，数据库将 `message` 保存为 `revise`。

首次配置或升级呼号提取协议时，将对应示例复制到宿主机配置目录。代码和配置需要一起升级，旧版 `Callsign` schema 不再适用：

```bash
# 简化版
cp examples/ai/simple/prompt.txt config/prompt.txt
cp examples/ai/simple/schema.json config/schema.json
# 完整版
cp examples/ai/full/prompt.txt config/prompt.txt
cp examples/ai/full/schema.json config/schema.json
```

也可通过已有的 `AI_LLM_PROMPT_FILE` / `AI_LLM_SCHEMA_FILE` 指向其他文件。任一文件缺失时 LLM 后处理不生效。

呼号模型接受时返回四个字段，例如：

```json
{"speaker":"self","quote":"这里是 Bravo Golf Five Bravo Juliet Oscar","callsign":"BG5BJO","evidence":2}
```

`speaker` 表示该呼号与当前发言人的关系，`quote` 必须是当前语音识别文本中的逐字自报片段，`evidence` 引用程序提取的字母解释法证据。明确是对方时返回 `{"speaker":"other"}`，缺证据或身份不明时返回 `{"speaker":"unknown"}`。完整版在这些结果中仍必须包含 `message` 和 `risk`。字段名 `callsign` 小写，呼号值统一为大写。

程序先从当前及有效历史的原始 ASR 提取解释法证据，再核验模型的呼号、证据编号与当前自报引用。裸呼号、直接报单字母、模型先前生成的呼号以及规范化文本都不能创建拼读证据；紧凑前缀及数字可以配合相邻的完整解释法后缀。被叫、复述确认和第三方呼号不作为当前说话人发布。没有证据或无法确定身份时宁可漏识别。

LLM 历史按节点保留原始转写、分段 ID 与发射分段关系，按 `AI_CONTEXT_WINDOW_MS` 过期，超预算时删除完整旧轮次。同一次长发射拆出的相邻片段可共同提供拼读证据；普通轮次间的半截拼读不能直接拼接。ASR 历史的使用方式保持原有行为。

呼号复核默认关闭，开关直接写在 `apps/backend/src/ai/llm-parser.ts` 的 `CALLSIGN_RECHECK_ENABLED` 常量里，不增加环境配置。以后启用时，也只对模型声称 `self`、候选或引用核验失败、且程序独立找到解释法与当前自报依据的情况最多复核一次。正常 `other` / `unknown`、没有证据的结果不复核；复核失败仍留空。网络请求的原有重试与这次语义复核分开处理。

只有通过核验的呼号才保存和发布到 AI Spot；已有 `AI_LLM_PUBLISH_SPOT=false` 可以关闭发布。

`recognition` 保留原始 ASR，`corrected` 保留现有音素纠错辅助文本。本次仅修复完整解释词 `X Ray` 被拆开后误改为 `Echo Ray`；其他音素词表、距离阈值和混淆规则保持原有行为。辅助文本不会取代原始拼读证据。

可选的 `AI_CALLSIGN_HINTS_ENABLED=true` 会从 `config/callsigns.txt` 检索相似呼号，规则和热更新方式保持不变。相似度提示只供参考，不能扩充解释法证据候选，不能覆盖原文拼读，也不能证明当前说话人身份。仅凭库中的相似呼号不会输出呼号。

不调用 LLM 即可手动检查片段提取和相似度候选：

```bash
npm run callsign-match-test -- "这里是 BG5FVT，Bravo Golf Five Foxtrot Bravo Tango"
npm run phonetic-corrector-test -- "Bravo Golf Five Foxtrot 补拉窝 Tango"
```

输出仅包含 `source`（提取的疑似呼号片段列表）和 `candidates`（合并后距离小于等于 1 的全部候选，不限制数量）。`candidates` 的 `distance` 是编辑距离，越小越相似；`score` 是 0–1 的相似度得分，越高越相似。

```
[260809 21:40:12] [1900]: 9f2ab1c4 6.2s 呼号=BD5XXX | 呼叫 CQ，这里是 BD5XXX，杭州
[260809 21:40:30] [1900]: 风控告警 9f2ab1c4 L5: 煽动非法集会与暴力行为
[260809 21:41:00] [1900]: 3c8d90aa 4.1s | 抄收了，在仓前街道那边，这里是 BG5BJO   ← LLM 失败时降级输出原始识别
[260809 21:42:00] [1900]: a1b2c3d4 3.5s 呼号=BG5BJO | 抄收了，在仓前街道那边，这里是 BG5BJO   ← 简化版：revise/risk 为空，呼号照常识别
```

### AI Spot 面板

识别到呼号时，地图页右侧面板（AI Spot）展示最近呼号，相同呼号只保留最新一条。首次加载从 SQLite 的 `ai_segments_effective` 读取历史，人工复核呼号优先；实时更新经 Core NATS subject `iaxmon.nodes.<节点>.ai.spot.<呼号>` 和 `/status` WebSocket 推送。无需启用 JetStream。人工确认无呼号时可设 `manual_callsign = 'N0CALL'`，它会覆盖 AI 结果但不会显示为 Spot。

控制台输出按节点区分：

```
[260809 21:05:12] [1900]: 丢弃段 2.1s（冷启动，时长不足 5s）
[260809 21:05:40] [1900]: 丢弃段 1.2s（热启动，时长不足 2s）
```

### 接口配置

语音识别与大语言模型完全独立：ASR 使用 DashScope 同步接口；LLM 使用 OpenAI 兼容接口，可指向任意供应商。旧的 `DASHSCOPE_API_KEY` / `DASHSCOPE_BASE_URL` 仅作为 ASR 的兼容别名，LLM 不会再读取它们。

| 环境变量 | 默认值 | 说明 |
|---|---|---|
| `AI_ASR_API_KEY` | 未设置 | ASR Key，任一节点启用 AI 时必填；兼容旧变量 `DASHSCOPE_API_KEY` |
| `AI_ASR_BASE_URL` | `https://dashscope.aliyuncs.com` | ASR 端点；兼容旧变量 `DASHSCOPE_BASE_URL` |
| `AI_ASR_MODEL` | `qwen-audio-3.1-asr-flash` | 识别模型（也可用 `fun-asr-flash`） |
| `AI_LLM_API_KEY` | 未设置 | LLM Key，`AI_LLM_ENABLED=true` 时必填 |
| `AI_LLM_BASE_URL` | `https://dashscope.aliyuncs.com/compatible-mode/v1` | OpenAI 兼容 base URL，需包含版本前缀（如 `https://api.deepseek.com/v1`）；客户端追加 `/chat/completions` |
| `AI_LLM_MODEL` | `qwen3.7-flash` | LLM 后处理模型 |
| `AI_LLM_ENABLED` | `true` | LLM 后处理开关 |
| `AI_LLM_PUBLISH_SPOT` | `true` | 识别到呼号时是否发布到 AI Spot 面板 |
| `AI_LLM_ENABLE_THINKING` | `qwen*` 模型为 `false`，其他模型不发送 | 思考模式；DeepSeek 映射为 `thinking.type`，Qwen 映射为 `enable_thinking` |
| `AI_LLM_THINKING_BUDGET` | 未设置 | 思考 token 预算（仅 Qwen 系使用），开启思考时限制思考量 |
| `AI_LLM_TIMEOUT_MS` | `30000` | 单次请求超时 |
| `AI_LLM_PROMPT_FILE` | `config/prompt.txt` | LLM 提示词文件路径（示例见 `examples/ai/simple/prompt.txt`） |
| `AI_LLM_SCHEMA_FILE` | `config/schema.json` | LLM 输出 JSON Schema 路径（示例见 `examples/ai/simple/schema.json`） |
| `AI_CALLSIGN_HINTS_ENABLED` | `false` | 是否向 LLM 提供常见呼号相似度候选 |
| `AI_CALLSIGNS_FILE` | `config/callsigns.txt` | 常见呼号表路径，每行一个呼号 |

LLM 请求使用 `response_format: json_object`（DeepSeek JSON Output）。模型返回空内容、非 JSON 或不符合 schema 时会被静默忽略，只输出 ASR 原文，不会报错或中断识别。

### 识别与持久化

| 环境变量 | 默认值 | 说明 |
|---|---|---|
| `AI_COLD_MIN_SEGMENT_MS` | `5000` | 冷启动时长阈值，不足丢弃 |
| `AI_HOT_MIN_SEGMENT_MS` | `2000` | 热启动时长阈值，不足丢弃 |
| `AI_ACTIVITY_WINDOW_MS` | `30000` | 冷/热启动判定的活动窗口 |
| `AI_MAX_SEGMENT_MS` | `120000` | 超过该值的段切分，最大 290000 |
| `AI_CONTEXT_WINDOW_MS` | `300000` | 识别结果上下文窗口 |
| `AI_PERSISTENCE_ENABLED` | `false` | 是否持久化 SQLite 结果及 WAV 录音 |
| `AI_DATABASE_FILE` | `data/ai.sqlite` | AI 识别与人工复核结果的 SQLite 文件路径 |
| `AI_RECORDINGS_DIR` | 与数据库同级的 `rec` | 成功识别语音的 WAV 存储目录 |
| `AI_ADMIN_FILE` | `config/admin.json` | 管理页面账号配置文件路径 |
| `AI_SESSIONS_FILE` | `data/sessions.json` | 管理登录会话文件路径 |
| `AI_HOTWORDS_FILE` | `config/hotwords.json` | 热词文件路径 |
| `AI_BACKGROUND_FILE` | `config/background.txt` | 背景文本文件路径 |

## 运行

```bash
npm install
npm run dev
```

`npm run dev` 会同时启动后端、公开端和管理端 Vite 开发服务器。打开 `http://localhost:5173` 查看实时节点拓扑，`http://localhost:5174/admin/` 查看管理端；两个应用都分别构建、分别开发。公开端将 `/api`、`/audio` 和 `/status` 代理到 `http://localhost:3000`，管理端只代理 `/api`。`/map` 仍作为兼容入口。

也可以使用 `npm run dev:backend`、`npm run dev:public` 或 `npm run dev:admin` 单独启动一个 workspace。节点展示 nodeId、名称、在线状态、本地/远程/系统发射状态以及本进程观察到的最近一次发射时间。

`config/nodes.json` 是地图的静态节点与链路配置。服务启动时会立即根据该文件生成默认离线状态，无需等待 Allmon3 返回；后续实时数据逐项覆盖默认值。`TYPE` 支持 `HUB` 和 `REPEATER`，`NAME` 保存节点短名称，`LINK` 声明允许显示的拓扑边，`FREQ` 保存中继频率信息；HUB 配置 `AUDIO: true` 时，地图节点会显示音频播放控件。

生产环境：

```bash
npm run build
npm start
```

生产构建分别输出到 `apps/public/dist` 与 `apps/admin/dist`，由后端按 `/` 和 `/admin/` 直接托管，因此现有单端口部署方式不变。

反向代理需要允许 `/audio` 和 `/status` 的 WebSocket Upgrade。`GET /healthz` 可用于存活检查。

### 管理页面

启用 `AI_PERSISTENCE_ENABLED=true` 后，访问 `/admin/` 查看已持久化的识别记录。页面按时间倒序分页展示中国时区的记录，可播放录音，并可编辑人工复核呼号；留空会撤销人工覆盖，`N0CALL` 表示人工确认无呼号。

管理账号文件默认是 `config/admin.json`，不提交到 Git。先生成密码哈希：

```bash
npm run hash-admin-password -- '替换为强密码'
```

再创建 `config/admin.json`：

```json
{
  "users": [
    {
      "username": "admin",
      "passwordHash": "粘贴上一步输出的 scrypt$..."
    }
  ]
}
```

登录会话保存在 `data/sessions.json`，首次启动会自动创建。每个会话有效期为 7 天；服务启动、登录、认证和登出时都会清理过期会话，服务重启后未过期的会话仍有效。文件仅保存随机 cookie token 的 SHA-256 哈希，不保存原始 token。登录密码使用异步 scrypt 校验，并按来源地址和用户名分别限制为每 5 分钟最多 10 次尝试；成功登录会重置计数。会话 Cookie 使用 `HttpOnly` 和 `SameSite=Strict`，检测到 HTTPS 或 `X-Forwarded-Proto: https` 时还会设置 `Secure`。反向代理终止 TLS 时应转发该协议头。持久化启用时 `admin.json` 必须存在且格式正确；Compose 部署时它位于只读挂载的 `./config/admin.json`。

## Docker

镜像基于 `node:24-alpine` 多阶段构建，只安装生产依赖，以非 root 用户 `node` 运行，内置 `/healthz` 健康检查，并通过 `tini` 保证 `SIGTERM` 能触发优雅关闭。

```bash
docker build -t iaxweb .

docker run --rm -p 3000:3000 \
  -e NATS_SERVERS=nats://nats.example:4222 \
  -e NATS_SUBJECT_ROOT=iaxmon.nodes \
  iaxweb
```

配置全部通过环境变量注入（`-e` 或 `--env-file`），镜像内不包含 `.env`。容器默认监听 `0.0.0.0:3000`，可用 `-e PORT=` 调整。

也可用 Compose，宿主机端口映射为 `8059`：

```bash
docker compose up -d
```

打开 `http://localhost:8059`。`docker-compose.yml` 使用远程镜像 `ghcr.io/tallcode/iaxweb:latest`（见下方 CI），将当前 `config/` 和 `data/` 挂载进容器，并通过 `env_file: .env` 注入全部运行配置。因此 `NATS_SERVERS` 必须填**容器内可达**的地址——不要用 `127.0.0.1`（那是容器自身）。Docker Desktop 下访问宿主机的 NATS 用 `host.docker.internal`，生产环境直接填 NATS 集群地址。仓库未创建 `.env` 时 Compose 仍可使用代码默认值启动，但实际部署建议先从 `.env.example` 复制并修改。

`docker compose stop` 和 `docker compose down` 会先向容器发送 `SIGTERM`；镜像中的 `tini` 会将信号转发给服务，服务依次停止 AI/NATS/WebSocket 并关闭 SQLite。避免使用 `docker kill`，它会直接发送不可处理的 `SIGKILL`。

## 镜像发布（GitHub Actions）

`.github/workflows/docker-publish.yml` 会在推送到 `main` 时自动构建镜像并推送到 GitHub Packages：

```
ghcr.io/tallcode/iaxweb:latest
ghcr.io/tallcode/iaxweb:sha-<commit>
```

首次发布后，包默认是私有的：`docker compose up` 拉取前需要 `docker login ghcr.io`，或在 GitHub 的 Package 设置里把可见性改为 Public。

## WebSocket 数据

### `/audio/<nodeId>`

节点 ID 为必填路径参数，并且必须是 `config/nodes.json` 中设置了 `AUDIO: true` 的节点。比如 `/audio/1900` 转发 `iaxmon.nodes.1900.audio/events`，`/audio/1800` 转发 `iaxmon.nodes.1800.audio/events`。不同节点的 WebSocket、NATS 状态和监听人数完全隔离。未知或未开启音频的节点会拒绝升级。

网关直接把该节点 `<subject_prefix>.audio` 的 NATS 二进制 payload 转发为 WebSocket 二进制消息，把 `<subject_prefix>.events` 以及当前状态快照转发为文本 JSON。浏览器依据 iaxmon `NATS.md` 中的版本、类型、时间戳和 PCMU payload 解码播放。

每个网关进程各自订阅完整 NATS 流，不使用 queue group；同一进程内的所有浏览器共享该订阅。慢速浏览器的待发送数据超过 4 KiB 时，网关会丢弃新音频帧，避免积压陈旧实时音频。网关与 NATS 断开时会向浏览器发送离线状态，重连后重新请求状态快照。

网关按节点统计处于 OPEN 状态的 `/audio` WebSocket 数量，并在人数变化时及每 15 秒向该节点 `<subject_prefix>.listeners` 上报。进程退出时主动上报 0；异常退出则由 iaxmon 的心跳租约自动剔除。浏览器只有点击播放后才建立 `/audio`，因此无人收听的节点不会建立 IAX 呼叫；一个节点的连接和断线不影响其他节点。具体消息格式、租约和一分钟断开防抖见 iaxmon 的 `NATS.md`。

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

设置了 `AUDIO: true` 的节点还包含 `LISTENERS`，表示 iaxmon 汇总的当前有效 Gateway 播放会话数；地图在未播放时用 users 图标和数字展示该值。

首次收齐全部节点详情后发送一次。之后只有收发状态、PTT、连接、名称或节点列表等实际状态发生变化时才向所有客户端发送完整 JSON；`UPTIME`、`RELOADTIME`、`CTIME`、`SSK`、`SSU` 等持续递增的计时字段不会单独触发消息。新连接的客户端会立即收到当前完整快照。每次广播同样会向服务端控制台输出一行 JSON。

每个节点还包含网关派生字段 `TX_SOURCE`（`local`、`remote`、`system` 或 `null`）和 `LAST_TX_AT`（ISO 8601 时间或 `null`）。最近发射时间保存在当前网关进程内；进程启动前的历史发射无法从 Allmon3 状态协议中恢复。

地图始终绘制 `config/nodes.json` 的 `LINK` 中声明的计划链路：Allmon3 `CONNS` 显示已建立连接时使用实线，否则使用虚线。若 Allmon3 报告了未在 `LINK` 中声明的动态连接，连接建立期间也会临时绘制为实线，断开后自动消失。HUB 使用独立样式并隐藏发射状态与最近发射时间，中继节点保持完整发射信息。
