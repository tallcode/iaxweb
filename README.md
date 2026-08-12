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
| `NATS_SUBJECT_ROOT` | `iaxmon.nodes` | 与 iaxmon `nats.subject_root` 一致 |
| `NATS_USERNAME` / `NATS_PASSWORD` | 未设置 | 用户名密码认证，必须一起配置 |
| `NATS_TOKEN` | 未设置 | Token 认证，不能与用户名密码共用 |
| `ALLMON3_BASE_URL` | `http://172.16.211.199/allmon3/` | Allmon3 根地址，必须以 HTTP(S) 访问 |
| `ALLMON3_REFRESH_INTERVAL_MS` | `30000` | 刷新节点列表、名称和端口的间隔 |
| `ALLMON3_REQUEST_TIMEOUT_MS` | `10000` | Allmon3 HTTP 请求超时 |

旧版 `NATS_SUBJECT_PREFIX` 是包含单个节点 ID 的完整前缀，无法无歧义地迁移为多节点根。
升级时必须删除该变量并设置 `NATS_SUBJECT_ROOT`；服务检测到旧变量会直接报错，避免静默订阅错误 subject。

## AI 值机员

AI 值机员监听节点音频，按发射分段（iaxmon 的 `start`/`stop` 事件），把语音段（冷启动 ≥5 秒、热启动 ≥2 秒，最长 2 分钟）送阿里云百炼语音识别（Qwen-Audio-3.0-ASR-Flash 同步接口），识别结果输出到控制台。

在 `nodes.json` 中为节点添加 `"AI": true` 启用（该节点必须同时 `"AUDIO": true`），并在 `.env` 设置 `DASHSCOPE_API_KEY`：

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

- `ai/hotwords.json`：即时热词，格式 `{"词": 权重}`，权重 1~5（或 50 超热词）。适合放呼号、Q 简语、值机常用词；
- `ai/background.txt`：背景文本（400 字以内），如网名称、NCS、流程说明。

LLM 后处理：每条识别结果再调用文本模型，对识别文本做结构化解析。调用时附带最近 `AI_CONTEXT_WINDOW_MS` 内的解析历史作为对话上下文。输出按 schema 文件严格校验，不合规记警告。`AI_LLM_ENABLED=false` 可关闭：

默认只进行实时识别，不持久化数据。设 `AI_PERSISTENCE_ENABLED=true` 后，识别成功的音频段会写入 SQLite（默认 `data/ai.sqlite`），并保存原始 WAV 到 `data/rec/YYYYMMDD/<segmentId>.wav`（按 UTC 日期分目录，便于按天清理）。ASR 完成后立即写入原始文本和录音，LLM 成功后更新同一行的 `revise`、`callsign` 和 `risk` 结果；LLM 失败不会丢失 ASR 数据。表中同时预留 `manual_callsign`、`manual_risk_level`、`manual_note` 三个人工复核字段。读取最终呼号和风险等级时使用 `ai_segments_effective` 视图，其中人工复核值优先，AI 原始结果保持不变。可通过 `AI_DATABASE_FILE` 和 `AI_RECORDINGS_DIR` 指定位置。使用随附 Compose 部署时，宿主机 `./data` 已挂载为容器内 `/app/data`；请先以部署用户创建该目录，并把其 UID/GID 配置为 `PUID`/`PGID`（默认 `1000:1000`），确保可写。

提示词与输出 schema 决定解析行为，有两套可选（每次调用前重新读取，保存后立即生效）：

- 完整版：`ai/example/full/`，规范化文本到 `revise`、提取发言人呼号到 `Callsign`（识别不出或不一致时省略）、风控判断到 `risk`；
- 简化版：`ai/example/simple/`，只提取发言人呼号到 `Callsign`，`revise` 和 `risk` 永远为空（控制台仍打印原始识别文本）。

两套底层管线完全一致，切换模式只需把对应示例复制到默认位置（默认使用 `ai/prompt.txt` + `ai/schema.json`，当前为简化版）：

```bash
# 启用简化版
cp ai/example/simple/prompt.txt ai/prompt.txt
cp ai/example/simple/schema.json ai/schema.json
# 切回完整版
cp ai/example/full/prompt.txt ai/prompt.txt
cp ai/example/full/schema.json ai/schema.json
```

也可用 `AI_LLM_PROMPT_FILE`/`AI_LLM_SCHEMA_FILE` 直接指定任意路径而不复制。两个默认文件任一缺失时 LLM 后处理不生效（等同 `AI_LLM_ENABLED=false`），此时输出原始识别文本。

识别到呼号时默认发布到 AI Spot 面板（见下节）；`AI_LLM_PUBLISH_SPOT=false` 可关闭，此时只记日志、不发布呼号。

可选的常见呼号相似度提示默认关闭。设置 `AI_CALLSIGN_HINTS_ENABLED=true` 后，系统从 `ai/callsigns.txt` 读取常见呼号（每行一个，支持 `#` 注释），从当前 ASR 文本提取紧凑形式、逐字拼读或字母解释法片段。ASR 原文会保存为 `recognition`，独立的闭集音素纠错结果保存为 `corrected`；ASR 上下文始终使用原文，呼号候选及省钱短路则使用 `corrected`。LLM 的当前文本和历史都遵循同一规则：始终保留 ASR 原文；仅当 `corrected` 与原文不同且含有 `Bravo` 或 `Boston` 时，才紧随其后附带一段简短标注的音素纠错辅助文本，避免无意义的 token 消耗。英文通过 CMUdict 取无重音 ARPABET 音素（例如 `alfa` → `alpha`），中文通过 `pinyin-pro` 取无声调拼音（例如“补拉窝” →“布拉沃” → `Bravo`），然后将音素/音节 token 编码后使用 `fastest-levenshtein` 比较。中文仅在无声调拼音序列完全一致时纠正；英文只有最佳候选距离不大于 1 且没有同分字母时才纠正。对字母解释语境中连续的 2–3 个英文词，系统还会以清浊/元音/鼻音等音素类别做滑动窗口比对；因此 `thank you` 在这类语境中可纠正为 `Tango`，但普通致谢不会被改写。`flower` → `Bravo` 仍作为 ASR 专属混淆表保留。归一化后再以位置敏感的 Levenshtein 距离选出已知呼号候选供 LLM 纠错。每个原文片段独立保留自己的最小距离候选，只有距离恰为 1 的候选会进入 LLM hint；距离 0 的库内命中不会提示，避免把紧凑形式误当成拼读证据。长粘连串只保留具有完整字母后缀的窗口，避免半截呼号污染候选。候选只是历史数据库检索结果；LLM 必须以原文字母解释法、紧凑呼号和通联语义为最高依据，不能用候选覆盖原文证据。呼号表在每次 LLM 调用前重读，保存后无需重启。

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

| 环境变量 | 默认值 | 说明 |
|---|---|---|
| `DASHSCOPE_API_KEY` | 未设置 | 百炼 API Key，任一节点启用 AI 时必填 |
| `DASHSCOPE_BASE_URL` | `https://dashscope.aliyuncs.com` | DashScope 端点 |
| `AI_ASR_MODEL` | `qwen-audio-3.0-asr-flash` | 识别模型（也可用 `fun-asr-flash`） |
| `AI_COLD_MIN_SEGMENT_MS` | `5000` | 冷启动时长阈值，不足丢弃 |
| `AI_HOT_MIN_SEGMENT_MS` | `2000` | 热启动时长阈值，不足丢弃 |
| `AI_ACTIVITY_WINDOW_MS` | `30000` | 冷/热启动判定的活动窗口 |
| `AI_MAX_SEGMENT_MS` | `120000` | 超过该值的段切分，最大 290000 |
| `AI_CONTEXT_WINDOW_MS` | `300000` | 识别结果上下文窗口 |
| `AI_PERSISTENCE_ENABLED` | `false` | 是否持久化 SQLite 结果及 WAV 录音 |
| `AI_DATABASE_FILE` | `data/ai.sqlite` | AI 识别与人工复核结果的 SQLite 文件路径 |
| `AI_RECORDINGS_DIR` | 与数据库同级的 `rec` | 成功识别语音的 WAV 存储目录 |
| `AI_HOTWORDS_FILE` | `ai/hotwords.json` | 热词文件路径 |
| `AI_BACKGROUND_FILE` | `ai/background.txt` | 背景文本文件路径 |
| `AI_LLM_ENABLED` | `true` | LLM 后处理开关 |
| `AI_LLM_PUBLISH_SPOT` | `true` | 识别到呼号时是否发布到 AI Spot 面板 |
| `AI_LLM_MODEL` | `qwen3.7-flash` | LLM 后处理模型 |
| `AI_LLM_ENABLE_THINKING` | `false` | 思考模式；默认关闭（任务简单，开启会显著变慢并可能超时） |
| `AI_LLM_THINKING_BUDGET` | 未设置 | 思考 token 预算，开启思考时限制思考量 |
| `AI_LLM_TIMEOUT_MS` | `30000` | 单次请求超时 |
| `AI_LLM_PROMPT_FILE` | `ai/prompt.txt` | LLM 提示词文件路径（切换简化版：复制 `ai/example/simple/prompt.txt` 覆盖之） |
| `AI_LLM_SCHEMA_FILE` | `ai/schema.json` | LLM 输出 JSON Schema 路径（切换简化版：复制 `ai/example/simple/schema.json` 覆盖之） |
| `AI_CALLSIGN_HINTS_ENABLED` | `false` | 是否向 LLM 提供常见呼号相似度候选 |
| `AI_CALLSIGNS_FILE` | `ai/callsigns.txt` | 常见呼号表路径，每行一个呼号 |

## 运行

```bash
npm install
npm run dev
```

打开 `http://localhost:3000/audio.html?node=1900`，点击“播放”后页面会连接同源的 `/audio/1900` WebSocket；再次点击“停止”会关闭 WebSocket 和音频上下文。

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
  -e NATS_SUBJECT_ROOT=iaxmon.nodes \
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

### `/audio/<nodeId>`

节点 ID 为必填路径参数，并且必须是 `nodes.json` 中设置了 `AUDIO: true` 的节点。比如 `/audio/1900` 转发 `iaxmon.nodes.1900.audio/events`，`/audio/1800` 转发 `iaxmon.nodes.1800.audio/events`。不同节点的 WebSocket、NATS 状态和监听人数完全隔离。未知或未开启音频的节点会拒绝升级。

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

地图只绘制 `nodes.json` 的 `LINK` 中声明的链路：Allmon3 `CONNS` 显示已建立连接时使用实线，否则使用虚线；未出现在 `LINK` 中的动态连接不绘制。HUB 使用独立样式并隐藏发射状态与最近发射时间，中继节点保持完整发射信息。
