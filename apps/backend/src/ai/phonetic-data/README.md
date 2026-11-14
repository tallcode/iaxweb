# corrected 读音纠错

`service.ts` 使用 `corrected-transcript.ts` 生成辅助 `corrected` 文本。原始 ASR、候选提取、当前说话人校验及数据库格式保持原有实现；纠错结果不参与新增呼号候选。

在拼读语境内保留原有别名、CMUdict 与中文拼音纠错，再使用 `phonetic-near.ts` 对未知词进行严格读音匹配。距离上限为 0.08，与第二个不同字母的分差至少为 0.08；每词最多一次音素增删，每段最多一处新增近音替换。不确定时保留原文。裸呼号、设备型号及单独字母受到边界保护。

生成的 `data.ts` 包含 71 个音素单元、92 个通用读音模板及距离矩阵，不含历史转写或呼号名单。运行时只用已有 Node 依赖，不需要 Python、音频模型或网络请求。来源哈希见 `SOURCES.json`，第三方许可随数据保留。

## 本地验证结果

2026-11-14 对既有 530 条去重 ASR 比较旧纠错、仅新算法及兼容版本。兼容版本保留本批 13 处有效旧纠错，恢复两种同源“回拜克”转写为 Quebec，固定 41 条普通文本均未改写；避免旧版 Thank you、X300 和 BG5FAX 的错误替换。另有 19 条合成边界控制及单段近音编辑预算检查通过。它们不是独立录音准确率。

原有四个候选／身份模块的源码哈希与冻结基线一致，1100 个上下文候选结果一致。辅助 corrected 可能改变 LLM 参考输入，未进行新的云端端到端准确率评估。沿用现有发送规则：corrected 必须与原文不同且含 Bravo/Boston，才会作为独立辅助文本发送。复核仍关闭。

## 数据生成和历史回放

以下命令从仓库根目录运行，仅使用已有本地缓存：

```sh
python3 experiments/callsign-phonetics/export-near-data.py
npx eslint apps/backend/src/ai/phonetic-data/data.ts --fix
node --import tsx experiments/callsign-phonetics/corrected-replay.ts
```

生成器通过 `text-distance.py` 读取 `data/callsign-investigation/phonetic-research/` 中的公共 CSV、来源清单、许可及 `text-hybrid-round1/input.json` 的通用词典部分。回放另需该目录下的 `text-hybrid-round1/results.json`、`ordinary-panel.json` 和 `text-integration/baseline.json`。这些实验缓存未纳入 Git，命令不会下载缺失数据。只运行应用不需要这些缓存或生成脚本。

回放输出在 `corrected-only-round1/evaluation.json`，包括逐词纠错、旧能力保留检查、合成控制、运行源码哈希和评估限制。回放脚本不是项目单元测试入口。
