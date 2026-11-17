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
apps/backend/       HTTP 入口，以及 admin、records、spots、AI、Allmon3、gateway 等后端模块
apps/public/        公开拓扑 Vue 应用
apps/admin/         独立管理后台 Vue 应用
packages/contracts/ 前后端共享的 API、WebSocket schema 和由 schema 推导的 TypeScript 类型
config/             节点定义，以及可热更新的 AI 提示词、schema、热词及呼号配置
data/               SQLite、录音及其他可写运行数据
```

项目统一使用 npm 和 `package-lock.json`，运行环境要求 Node.js 24 或更新版本。

根目录使用 `@antfu/eslint-config` 统一检查 TypeScript、Vue、CSS、HTML 和 JSON。

管理后台的 `src/api/` 统一处理会话、用户和记录请求，校验请求参数与响应数据，并区分网络、HTTP、输入校验与协议错误。`src/composables/records/` 中的查询、编辑、删除和播放模块各自维护状态，页面组合它们，通过明确的只读状态与操作接口提供给 `src/components/records/`；输入框校验、弹窗与焦点管理由组件负责。

后端 `records/` 管理持久化记录与人工审核，`ai/` 负责识别流程，`spots/` 负责呼号广播。共享的记录数据库由 `server.ts` 创建并在服务关闭时释放，AI 与人工审核服务仅依赖各自需要的仓储操作。

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

LLM 后处理：每条识别结果再调用文本模型，对识别文本做结构化解析。ASR 与 LLM 的 Key、端点和模型完全独立，LLM 可以换成任意 OpenAI 兼容供应商（例如 DeepSeek、OpenAI），只需配置 `AI_LLM_BASE_URL`/`AI_LLM_API_KEY`/`AI_LLM_MODEL`，不影响语音识别。调用时附带最近 `AI_CONTEXT_WINDOW_MS` 内的解析历史作为对话上下文。输出通过 Ajv 按 JSON Schema 校验（支持项目示例的 2020-12 协议）；schema 在热更新时编译，无效配置沿用上次有效版本。`AI_LLM_ENABLED=false` 可关闭：

默认只进行实时识别，不持久化数据。设 `AI_PERSISTENCE_ENABLED=true` 后，识别成功的音频段会写入 SQLite（默认 `data/ai.sqlite`），并保存原始 WAV 到 `data/rec/YYYYMMDD/<segmentId>.wav`（按 UTC 日期分目录，便于按天清理）。ASR 完成后立即写入原始文本和录音，LLM 成功后更新同一行的 `revise`、`callsign` 和 `risk` 结果；LLM 失败不会丢失 ASR 数据。表中分别保留人工呼号 `manual_callsign`、被叫 `callee_callsign`、人工文本 `manual_recognition`、人工风险 `manual_risk_level` 和备注 `manual_note`；`reviewed` 表示识别文本、主叫与被叫均已人工复核，可用于训练，默认值为 `0`。升级时会自动在事务内为旧数据库补充人工文本和复核状态字段，原有数据保持不变。读取最终呼号和风险等级时使用 `ai_segments_effective` 视图，其中人工复核值优先，AI 原始结果保持不变。可通过 `AI_DATABASE_FILE` 和 `AI_RECORDINGS_DIR` 指定位置。

管理员桌面表格最右侧的“操作”列放置星标和红色垃圾桶按钮，点击垃圾桶后通过 HTML5 `<dialog>` 模态框再次确认，确认后永久删除数据库记录及对应 WAV 录音；移动端不提供删除按钮。录音已被清理时仍可删除记录；录音删除失败时回滚数据库删除。删除成功后重新加载当前筛选结果及总数，当前页变空时自动返回最后一个有效页。

管理页的录音播放状态按服务器上现存的 UTC 日期目录（`YYYYMMDD`）判断，不再限制录音必须在 30 天以内。后端只扫描录音根目录中的日期子目录，不逐条检查 WAV 文件，并将有效日期缓存在内存中 12 小时；并发请求共用扫描结果，新保存录音的日期会立即加入缓存。手动删除旧日期目录后，页面最迟在缓存到期后的下一次列表请求中显示“已过期”；重启服务会清空缓存并在下次请求时重新扫描。目录扫描失败时列表请求报错，不会将其当作所有录音已过期。

记录接口统一使用 `/api/admin/records`（包括编辑、标注、删除和录音播放子路径）。列表中每条记录的 `hasAudio` 布尔值由后端按日期目录缓存判断，前端直接据此显示“播放”或“已过期”，不再传输整个日期列表。当前用户身份只由 `/api/admin/session` 返回，记录列表与用户列表不附带 `user` 字段。

识别记录数据库在启动时自动补建时间排序、有效主叫呼号、已编辑与已标注的查询索引，旧库无需手动执行 SQL。`/api/admin/records` 响应通过 `Server-Timing` 头分别提供 `db`（计数及分页查询）和 `recordings`（录音日期缓存读取或扫描）的耗时，单位为毫秒，便于与浏览器端请求总耗时比较。

`config/` 和整个 `data/` 目录均被 Git 与 Docker 构建上下文忽略。Compose 将 `./config` 只读挂载到 `/app/config`，其中的节点定义、提示词、schema、热词、背景文本、呼号表和管理员账号由宿主机维护；容器进程不能改写这些配置。`./data` 则以可写方式挂载到 `/app/data`，保存 SQLite、WAL、录音和持久化的管理会话。请把部署用户的 UID/GID 配置为 `PUID`/`PGID`（默认 `1000:1000`），确保 `data/` 可读写且 `config/` 可读。

### SQLite 备份

可在宿主机上、服务运行期间创建数据库的一致性备份（需要宿主机安装 `sqlite3`）：

```bash
# 默认写入 /srv/iaxweb/data/backups/
./scripts/backup-sqlite.sh /srv/iaxweb/data

# 指定独立备份目录
./scripts/backup-sqlite.sh /srv/iaxweb/data /srv/backups/iaxweb
```

脚本使用 SQLite 的 `.backup`，会生成单个独立的 `.sqlite` 文件并执行完整性检查；不需要复制 `-wal` 或 `-shm`。它只备份数据库，不含 `data/rec/` 录音、`users.json`、`sessions.json` 或其他运行数据。

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

声纹使用 `sherpa-onnx-node@2.0.1` 与中文 `wespeaker_zh_cnceleb_resnet34_LM.onnx`，在独立 Worker 中常驻一个模型、CPU 2 线程，统一由原始 8 kHz PCM 走 sherpa 内部重采样。首次在宿主机准备 `config/models/wespeaker_zh_cnceleb_resnet34_LM.onnx`，可以执行一次 `npm run download:speaker-model` 或拷贝已校验的同一文件；下载及加载均校验模型 SHA-256。Docker 不下载、不打包模型，直接通过现有 `./config:/app/config:ro` 挂载读取。镜像使用 Debian slim（原生库需要 glibc）。可通过 `AI_SPEAKER_MODEL_FILE` 指向相同模型的其他位置，容器中必须使用容器内可读路径。不混用之前实验的 SciPy 重采样声纹。

只有管理员设为“已标注”的 record 才会从已保存的 WAV 计算并持久化声纹。标注操作与声纹 `pending` 任务在同一事务中保存；后台每 2 秒处理一批，启动时也会发现已有标注但缺失声纹的记录，重启后继续 `pending` 任务。SQLite 的 `ai_segment_embeddings` 表以 `record_id` 关联 `ai_segments.id`，保存 `version`、`status`、`embedding` 和可选的 `reason`（旧表自动添加）；向量为 256 维 little-endian Float32 BLOB，纯向量 1,024 字节。`status` 为 `pending`（等待/计算）、`ready`（成功）、`unavailable`（语音不足或质量不通过）、`failed`（异常或超时）。取消标注不删除已有声纹，但立即停止参与参考检索；任务提交前会再次检查标注状态，避免取消标注或删除记录后写回。重新标注会复用当前版本的 `ready` 声纹，其余终态可重新计算。删除 record 时级联删除声纹。

声纹提取前先在同一 Worker 内进行 8 kHz 频谱质量检查，手动查询、标注计算和历史补算共用：窄带谱峰相对附近背景突出度 `>18 dB`，或 `3000–3900 Hz / 150–3900 Hz` 能量占比 `>1.4%` 时，不调用声纹模型生成向量。已标注记录记为 `unavailable`、`embedding=NULL`，`reason` 分别为 `interference_tone`、`interference_high_band`。无效采样或语音不足同样跳过。质量策略版本包含 `quality-v1` 后缀，旧版向量不参与新版检索；后台会重新检查仍已标注的旧版记录，未标注的旧数据保留。这组规则来自 2026-11-17 的两类干扰样本，能排除这次的四条干扰；它是频谱启发式规则，不能保证检出所有干扰，也可能受设备、信道和语音内容影响。

声纹匹配目前仅用于管理员手动测试，不进入 ASR/LLM 主流程，也不自动处理新录音。管理页桌面操作栏和手机卡片提供 `fingerprint-pattern` 图标的“声纹识别”按钮，调用 `POST /api/admin/records/:id/speaker-recognition`；仅管理员有权限。点击后读取该条 WAV，先做质量检查，再临时计算查询向量。无论当前录音是否已标注，手动测试都不保存查询向量或声纹状态，不修改呼号，不调用 LLM。已标注录音的后台入库独立保留。

`sqlite-vec@0.1.9` 对全量历史“当前仍已标注、同版本、ready、有效主叫”的声纹进行精确余弦搜索，阈值暂放宽为严格 `>0.80`，当前录音始终排除，避免自匹配。没有 5 分钟限制，也不先取全库 top-K 再过滤标注。主叫使用 `COALESCE(manual_callsign, callsign)`，不读取被叫呼号，排除 `N0CALL`；管理员改呼号后下次查询直接使用新值，无需重算声纹。使用普通 BLOB 表加 `vec_distance_cosine`，不额外复制向量到虚拟表。数据库连接加载扩展后关闭继续加载扩展的权限。

弹窗按呼号显示 `count`（命中录音条数）、`maxSimilarity`、`minSimilarity`、`averageSimilarity`，手机端只显示呼号、数量和平均值，完整统计仍由接口返回并在桌面展示。统计仅包含相似度超过 0.80 的录音。按命中条数降序，再按最大值、平均值和呼号排序；数量不是身份概率，不将分数显示成置信概率。响应同时返回 `referenceCount`（排除自身后的合格参考录音数）、阈值和状态。无结果会区分参考库为空、未达阈值、干扰、语音不足、录音缺失/无效、模型异常、超时和检索失败。请求和弹窗结果不缓存，取消/删除标注后后续查询立即生效。

声纹任务含排队最多等待 10 秒，不绕过质量检查。标注录音损坏、单条提取异常或超时记为 `failed`；模型、原生库暂不可用或队列繁忙时，后台保留 `pending` 稍后重试。手动测试异常仅返回原因，不向数据库写入查询声纹数据。Worker 超时或崩溃时清理等待任务并终止 Worker，退避 60 秒后重建。手动查询和标注任务共享一个常驻模型，标注任务逐条提取、每批最多 10 条；队列最多容纳 16 个任务，停止服务时清理等待任务，未完成的已标注 `pending` 由下次启动恢复。

5 分钟文字上下文和原有呼号证据校验保留。发给模型的 JSON 保留完整字段名和原始 UUID：`history` 每条仅包含 `id`、`text`，`current` 包含 `id`、`text`；`candidates` 保留 `id`、`segmentId`、`callsign`、`kind`、`quote`，按需保留 `prefixQuote`、`segmentIds` 和复核建议引用。`transmissionId`、`partIndex`、`start`、`end` 仅在程序内部保留。声纹结果不注入 `referenceCallsigns` 或 `similarityHints`，原有 `0.70/0.80` 历史 `speaker` 标注已取消。输出 schema 在请求中去掉格式缩进，输出协议保持不变。

呼号复核默认关闭，开关直接写在 `apps/backend/src/ai/llm-parser.ts` 的 `CALLSIGN_RECHECK_ENABLED` 常量里，不增加环境配置。以后启用时，也只对模型声称 `self`、候选或引用核验失败、且程序独立找到解释法与当前自报依据的情况最多复核一次。正常 `other` / `unknown`、没有证据的结果不复核；复核失败仍留空。网络请求的原有重试与这次语义复核分开处理。

只有通过核验的呼号才保存和发布到 AI Spot；已有 `AI_LLM_PUBLISH_SPOT=false` 可以关闭发布。

`recognition` 保留原始 ASR，`corrected` 保留现有音素纠错辅助文本。本次仅修复完整解释词 `X Ray` 被拆开后误改为 `Echo Ray`；其他音素词表、距离阈值和混淆规则保持原有行为。辅助文本不会取代原始拼读证据。

LLM 请求不再发送 `similarityHints`，也不再读取 `AI_CALLSIGN_HINTS_ENABLED`。常见呼号表仅保留给离线 `callsign-match-test` 命令使用。

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

### 已标注历史录音的声纹补算

`npm run backfill:speaker` 在独立进程中读取服务器已有 WAV，只为当前已标注的历史 records 写入 `ai_segment_embeddings`。它只计算声纹，不调用 ASR/LLM，不修改转写、呼号、人工标注或录音。默认使用 `.env` 中的 `AI_DATABASE_FILE`、`AI_RECORDINGS_DIR`、`AI_SPEAKER_MODEL_FILE`；显式路径参数建议使用绝对路径。

先部署新版数据库结构并准备模型，再盘点和预跑：

```bash
# 首次在宿主机准备模型；已存在且 SHA-256 正确时只校验，不重复下载
npm run download:speaker-model

# 只盘点并保存候选清单，不写入数据库
npm run backfill:speaker -- --dry-run

# 先计算 500 个候选；自动使用盘点生成的清单
npm run backfill:speaker -- --limit 500

# 继续剩余记录；无需记住或指定任务目录
npm run backfill:speaker

# 单独重试当前版本的失败记录，或重新检查 unavailable（如录音已恢复）
npm run backfill:speaker -- --retry-failed --delay-ms 100
npm run backfill:speaker -- --retry-unavailable --delay-ms 100
```

直接执行 `npm run backfill:speaker` 即可。程序按数据库、模型版本、录音路径和重试类型自动寻找未完成任务并续跑；没有未完成任务时才生成新清单，默认跳过已有声纹。`--dry-run` 会重新盘点并更新当前任务清单。`--limit` 限制本次处理的候选数量，盘点仍覆盖任务开始前的全部已标注历史。录音路径按原始 `captured_at` 的 UTC 日期定位，实际检查文件，不依赖管理页按日期目录缓存的 `hasAudio`。盘点检查路径、文件是否存在及是否为普通文件；WAV 内容损坏在读取阶段识别。

默认单 Worker、模型 CPU 2 线程，每条间隔 100 ms，每 50 条提交一次短事务，每 100 条打印吞吐和预计剩余时间。模型计算及文件读取期间不持有数据库写事务；SQLite 临时锁冲突会退避重试。读取音频有大小、格式和时长限制，始终使用同一套 PCM16 单声道 8 kHz 解码与正式声纹提取流程。

任务目录默认位于数据库旁的 `embedding-backfill/`，包含：

- `manifest.json`：本次固定候选 ID、筛选方式、版本、路径和盘点统计。
- `backup.sqlite`：首次写入前通过 Node SQLite backup API 创建并验证完整性的备份；同一任务续跑沿用该备份。
- `progress.json`：已提交位置、任务状态和结果计数。
- `results.jsonl`：逐条处理结果和具体失败原因，不保存音频或重复的声纹向量；中断边界附近可能出现重放日志。
- `coverage.json`：候选 records 当前在数据库中的实际状态统计。它与进度计数独立核对，适用于写入完成但进度文件尚未落盘的中断情况。

Ctrl+C 或 SIGTERM 会尽量提交已计算结果并保存暂停位置，以退出码 130 结束；随后再次执行相同命令即可自动续跑。进度文件只在数据库提交后推进，意外退出后会重新检查数据库，跳过已完成数据，重复计算未提交数据。已有 `ready`、实时 `pending` 和其他版本的数据都不会被默认补算覆盖；重试也只更新选择的终态和完全相同的版本。处理过程中已删除的 record 会跳过，不会重新创建。

补算不使用应用启动时的 `pending` 恢复逻辑，也不向数据库写入自己的 `pending`；进行中的位置记在任务文件，只有最终结果才写数据库。补算清单只包含已标注记录，逐条处理和事务提交时再次检查标注状态，取消标注后跳过写入，已保存的声纹保留。新版清单格式为 2，不会恢复旧版未限制标注的清单。缺失文件、语音不足或质量检查不通过记为 `unavailable`，干扰原因同步保存在表的 `reason` 和任务的 `results.jsonl`，不存声纹向量；损坏 WAV 或单条提取错误记为 `failed`。权限、数据库持续写入异常、Worker 不可用或连续提取异常会停止任务，保留进度，不把剩余候选批量标成失败。

同一数据库通过旁路锁文件限制为一个补算进程，实时服务仍可正常运行。同一主机异常退出留下的锁会在确认原 PID 不存在后回收；若强杀后换了主机或容器，命令会提示核实原任务已停止后清理锁文件。任务文件和当前任务索引均由程序自动管理，不需要指定目录。默认补算、失败重试和 unavailable 重查分别维护进度，互不混用；可在续跑时调整本次 `--limit` 和 `--delay-ms`。

Docker 中可在现有服务容器运行同一命令，例如：

```bash
docker compose exec iaxweb npm run backfill:speaker -- --dry-run
# 先预跑 500 条，再直接执行相同命令继续
docker compose exec iaxweb npm run backfill:speaker -- --limit 500
docker compose exec iaxweb npm run backfill:speaker
```

完整选项见 `npm run backfill:speaker -- --help`，支持 `--database`、`--recordings`、`--model` 覆盖配置；通常直接读取 `.env`，无需指定任何路径。盘点可以读取尚未创建声纹表的旧数据库；实际写入要求先部署新版结构和 WAL 模式。

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
| `AI_CALLSIGNS_FILE` | `config/callsigns.txt` | 仅供离线呼号检索命令使用，每行一个呼号 |

LLM 请求使用 `response_format: json_object`（DeepSeek JSON Output）。模型返回空内容、非 JSON 或不符合 schema 时会被静默忽略，只输出 ASR 原文，不会报错或中断识别。

### 识别与持久化

| 环境变量 | 默认值 | 说明 |
|---|---|---|
| `AI_COLD_MIN_SEGMENT_MS` | `5000` | 冷启动时长阈值，不足丢弃 |
| `AI_HOT_MIN_SEGMENT_MS` | `2000` | 热启动时长阈值，不足丢弃 |
| `AI_ACTIVITY_WINDOW_MS` | `30000` | 冷/热启动判定的活动窗口 |
| `AI_MAX_SEGMENT_MS` | `120000` | 超过该值的段切分，最大 290000 |
| `AI_CONTEXT_WINDOW_MS` | `300000` | 识别结果及声纹历史上下文窗口 |
| `AI_SPEAKER_MODEL_FILE` | `config/models/wespeaker_zh_cnceleb_resnet34_LM.onnx` | 固定 WeSpeaker 模型文件；宿主机准备一次，Docker 通过 config 只读挂载使用 |
| `AI_PERSISTENCE_ENABLED` | `false` | 是否持久化 SQLite 结果及 WAV 录音 |
| `AI_DATABASE_FILE` | `data/ai.sqlite` | AI 识别与人工复核结果的 SQLite 文件路径 |
| `AI_RECORDINGS_DIR` | 与数据库同级的 `rec` | 成功识别语音的 WAV 存储目录 |
| `AI_ADMIN_FILE` | `config/admin.json` | 只读系统管理员账号配置文件路径 |
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

启用 `AI_PERSISTENCE_ENABLED=true` 后，访问 `/admin/` 查看已持久化的识别记录。 页面顶部显示“记录管理”、当前用户名和注销按钮；注销成功后清除当前会话并回到登录页。页面整体滚动，页头固定在顶部，搜索筛选栏以纯色背景固定在页头下，桌面表格列头在筛选栏下吸顶，底部分页保持可见。自动刷新检查窗口滚动位置，向下浏览记录时暂停，只有回到页面顶部、第一页且没有搜索、筛选、编辑或保存操作时才允许刷新。页面按时间倒序分页展示中国时区的记录，可播放录音，并可点击编辑识别文本、主叫和被叫呼号。人工识别文本最多 1000 字。人工文本优先展示，清空后恢复原始 AI 文本；Enter 保存、Shift+Enter 换行、Esc 取消。记录页同时只允许编辑一个字段，当前编辑保存成功或取消后才能编辑其他字段；编辑期间暂停筛选、翻页和自动刷新，保存失败保留输入。呼号提供保存与取消按钮，失去焦点不会自动取消，鼠标悬停不显示下划线。人工文本和主叫使用绿色，逐字差异以淡黄色背景标出，删除的 AI 文字不显示，悬停可查看 AI 原文；未人工修改时使用白色。呼号留空会撤销人工覆盖，人工主叫设为 `N0CALL` 时显示原 AI 呼号，使用白字、淡黄色背景和删除线。播放后方的星标按钮可保存或取消整条记录的复核状态，未标注时为空心星，已标注时为绿色实心星，已标注的行或卡片以淡绿色背景区分；编辑字段本身不会自动勾选。 顶部“已编辑”筛选识别文本、主叫或被叫任一字段有人工编辑值的记录，“已标注”筛选已勾选复核状态的记录；复选框切换后立即从第一页加载，可不填写呼号独立使用，也可与呼号搜索组合，同时勾选两个条件时取交集。清除人工编辑值后，该字段不再计入“已编辑”。

系统管理员账号文件默认是 `config/admin.json`，保持只读挂载，不提交到 Git。先生成密码哈希：

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

`admin.json` 中的账号固定为系统级管理员，不需要 `role` 字段，也不会出现在用户管理列表中，不能通过页面查询、修改、删除或被同名普通用户覆盖。只有在宿主机修改此文件并重启服务，才能变更系统账号。

其他用户存放在可写的 `data/users.json`（与 `AI_SESSIONS_FILE` 位于同一目录），文件不存在时自动创建为空列表。格式如下，密码仍使用上面的命令生成 scrypt 哈希：

```json
{
  "users": [
    {
      "username": "BG5ATV",
      "role": "editor",
      "passwordHash": "粘贴生成的 scrypt$..."
    },
    {
      "username": "guest",
      "role": "viewer",
      "passwordHash": "粘贴生成的 scrypt$..."
    }
  ]
}
```

普通用户角色配置为 `admin`（管理员）、`editor`（编辑人员）、`viewer`（查看人员）；旧数据角色缺失、空值或未知值均默认 `viewer`。管理员可编辑识别文本、主叫和被叫，可标注、删除记录及管理普通用户；编辑人员只能编辑未标注记录的这三个字段，管理员标注后记录对编辑人员锁定，取消标注后恢复可编辑；管理员不受此限制；查看人员只能浏览、搜索、筛选及播放录音。非管理员页面不显示“操作”列，移动端也隐藏标注操作；删除记录按钮仅在管理员的桌面表格中提供。后端对所有写接口独立校验权限，越权返回 403。

所有管理员都可通过页头入口访问 `/admin/users`，按用户名查询用户、新增账号、修改用户名与角色、重置密码或删除账号。用户名长度为 1–18 个字符，设置密码时长度为 1–32 个字符；编辑时密码留空表示不修改，删除需经 HTML5 `<dialog>` 再次确认。修改角色立即影响后续请求；删除用户或修改用户名、密码会使其已有会话失效。用户变更只写入 `data/users.json`，使用临时文件和原子替换保存，文件权限为 `0600`，接口不会返回密码或哈希。请备份此文件，并将它与 `config/admin.json` 一同迁移到部署环境。

登录会话保存在 `data/sessions.json`，首次启动会自动创建。每个会话有效期为 7 天；服务启动、登录、认证和登出时都会清理过期会话，服务重启后未过期的会话仍有效。文件仅保存随机 cookie token 的 SHA-256 哈希，不保存原始 token。登录密码使用异步 scrypt 校验，并按用户名限制为每 5 分钟最多 10 次尝试；成功登录会重置计数。会话 Cookie 使用 `HttpOnly` 和 `SameSite=Strict`，检测到 HTTPS 或 `X-Forwarded-Proto: https` 时还会设置 `Secure`。反向代理终止 TLS 时应转发该协议头。持久化启用时 `admin.json` 必须存在且格式正确；Compose 部署时它位于只读挂载的 `./config/admin.json`。

## Docker

镜像基于 `node:24-bookworm-slim` 多阶段构建，运行阶段只安装生产依赖，默认以非 root 用户 `node` 运行，内置 `/healthz` 健康检查，并通过 `tini` 保证 `SIGTERM` 能触发优雅关闭。使用 Debian/glibc 是为了支持 sherpa-onnx 的原生库，不使用 Alpine/musl。

模型由宿主机独立维护，不进入 Docker 构建上下文、不随镜像打包，构建和启动均不下载模型。首次部署只需在 `config/models/wespeaker_zh_cnceleb_resnet34_LM.onnx` 放置约 26.5 MB 的固定模型；可在本机执行一次 `npm run download:speaker-model`，再把文件随 `config` 同步到服务器，无需为此给服务器安装 Node.js。已有正确模型时下载命令只校验，不联网下载。后续拉取、构建或重建镜像都复用该文件。

Compose 已将 `./config` 只读挂载到 `/app/config`，因此容器默认读取 `/app/config/models/wespeaker_zh_cnceleb_resnet34_LM.onnx`，不需要新增挂载或设置 `AI_SPEAKER_MODEL_FILE`。如果 `.env` 曾显式设置旧的 `models/...` 路径，需改为 `config/models/...` 或删除该覆盖值。运行时仍验证固定 SHA-256，路径调整不改变声纹版本，也不要求重算现有向量。

```bash
docker build -t iaxweb .

docker run --rm -p 3000:3000 \
  -v "$PWD/config:/app/config:ro" \
  -v "$PWD/data:/app/data" \
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
