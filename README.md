# 素材审核与发布排期 Agent

基于 **Pi SDK 1.0.2 + TypeScript + SQLite** 的内容运营助手：核查素材、检查规则、处理时段冲突，经必要的本人确认后保存发布草稿。

业务架构采用 **Pi 决策 → 统一业务命令 → 显式状态机与业务校验 → SQLite 草稿事务**。Pi 负责根据观察选择动作；状态机校验合法迁移，记录真实状态变化。交付结果明确区分审核、风险、建议时段、待确认事项和草稿保存状态。

**当前交付：业务闭环与离线验证已实现。用户使用 Kimi K2.6 非思考模式执行了一次完整11场景运行，六项必验及补充场景经输出、Trace与实际SQLite交叉核对全部符合预期，见[核对报告](examples/live/acceptance-review.json)。另有聊天和跨进程恢复验证。数据为合成资料，确认由测试夹具模拟；尚未统计多次运行稳定性。各 Trace 明确标注 live 或 mock。**

## 快速运行

需要 Node.js **≥22.19.0** 和 npm，无需启动数据库服务。SQLite 参数由 npm 脚本提供；Node 22 可能打印 ExperimentalWarning。

```bash
npm ci --ignore-scripts
npm run cli -- pending
npm run cli -- run --input data/inputs/normal.json --mode mock
npm run verify
```

`verify` 执行类型检查、可执行测试、11 组离线场景、3 组离线聊天和依赖审计，实际报告写入 [examples/checks/verification.json](examples/checks/verification.json)。

运行状态与数据库默认保存在 `.runtime/`，仅保存在本机。不同演示可通过 `--db .runtime/demo-name.sqlite` 隔离。

## 业务聊天接口

```bash
npm run api
```

服务默认监听 `http://127.0.0.1:8787/api/chat`，自动加载本机 `.env`。向 `POST /api/chat` 发送业务消息：

```json
{"message":"把新品介绍放到2030年1月1日晚上六点，发抖音，帮我安排一下","requestId":"message-001"}
```

返回业务回复、`conversationId`、逐项审核/排期/草稿状态及待确认卡片。下一轮携带同一个 `conversationId`。确认使用返回的卡片标识，例如 `{"conversationId":"返回的会话标识","action":{"confirmationId":"返回的卡片标识","decision":"accept","kinds":["time_change"]}}`。

真实模式由模型理解自然语言，宿主验证原文中的素材、时间与资料依据，再进入同一 Pi 排期循环。业务响应不返回 Trace、内部路径、调用统计或原始工具结果；观测仍由后台 pi.on 收集。完整接口示例见 [业务聊天指南](docs/08-chat-guide.md)。

## 终端业务聊天

```bash
npm run cli -- chat --mode live --db .runtime/chat.sqlite
```

命令自动加载本机 `.env`。进入后可以逐条输入：

```text
查看待处理素材
将 M01 安排在 2030-01-01 18:00，渠道 douyin
为什么改到19:00？
同意改期
再处理一次相同请求
查看结果
退出
```

18:00 被占用时应建议 19:00，等待本人确认；同意后再次复检并保存草稿，重复处理返回原草稿。含风险警告时还需单独输入“接受风险”；拒绝使用“拒绝当前建议”。

真实模式由 Kimi 理解语义，支持按素材 ID 或唯一标题安排、自然语言追问与解释。关键字段须有用户原文依据；上海时间转换、整点要求及确认门禁由宿主验证。缺少信息会追问，模糊要求不会擅自改写。确认由本人明确输入或确认卡片记录，模型不能代批。

每个对话持续复用同一个 Pi Session，保留用户消息和实际业务回复；HTTP 重启后可从原生会话文件恢复。模糊输入如“统一”会澄清并保留当前建议，随后“同意”可继续确认；新请求、拒绝或建议版本变化仍使旧确认不可沿用。

终端每轮将当前任务与 Pi 会话关联写入 SQLite；同一数据库、actor 和模式重启时自动恢复。旧版本的任务可输入“查看 M06”或“M06”定位；唯一未完成任务可直接“补充M06标题为双十一优惠”。多个任务会要求明确原定时间及渠道。支持“下周一”等有明确周次的日期，按上海时间换算；输入“发布”会说明仅支持草稿。

无 API 离线体验用 `--mode mock`；离线语言理解是确定性替身，仅验证流程。业务聊天只展示业务结果。运维可在本地 `.runtime/chats/`、`.runtime/traces/` 查看消息和观测记录。

`npm run examples:chat` 生成三组离线聊天记录，`npm run examples:business-chat` 验证 HTTP 业务接口；`npm run smoke:business-chat` 使用真实模型验证自然表达、冲突解释、夹具确认、保存和重复提交，会产生 API 费用。脚本确认均标为测试夹具，不代表真实人工审批。

## 评审入口

| 入口 | 内容 |
|---|---|
| [需求](docs/01-requirements.md) | 用户、范围、成功标准、业务默认值 |
| [方案](docs/02-solution.md) | Pi 动态决策、确认边界、存储与工具职责 |
| [评估](docs/03-evaluation.md) | 六项验收映射、实际证据、失败与限制 |
| [AI 使用](docs/04-ai-usage.md) | 我使用 AI 的范围、个人参与和验证记录 |
| [复盘](docs/05-retrospective.md) | 实现难点、已修正问题、下一步 |
| [业务契约与状态机](docs/06-business-contract.md) | 统一命令、来源权限、合法迁移、确认与保存门禁 |
| [手工验收流程](docs/07-acceptance-guide.md) | 六项必验、状态查询、占用变更与重复提交 |
| [终端聊天](docs/08-chat-guide.md) | 自然语言示例、本人确认、资料补充、恢复和聊天记录 |
| [当前范围与整体架构](docs/09-scope-and-architecture.md) | 已实现能力、分层职责、验证依据和交付边界 |
| [提交检查清单](docs/10-submission-checklist.md) | 作业要求完成情况、待填写信息及可选改进 |
| [运行汇总](examples/mock/summary.json) | 11 组输入、实际输出、Trace、最终存储状态 |

## 本人确认流程

合成数据中 `2030-01-01 18:00` 已被占用，19:00 可用：

```bash
npm run cli -- run --input data/inputs/conflict.json --mode mock --db .runtime/conflict.sqlite
```

结果应包含原始要求 18:00、建议 19:00、`needs_confirmation`、`saveStatus: not_saved`。复制实际输出的会话、建议编号和版本：

```bash
npm run cli -- show --session SESSION_ID --db .runtime/conflict.sqlite
npm run cli -- state --session SESSION_ID --material M01 --channel douyin --db .runtime/conflict.sqlite
npm run cli -- confirm --session SESSION_ID --material M01 --channel douyin --proposal PROPOSAL_ID --version 1 --kinds time_change --decision accept --mode mock --db .runtime/conflict.sqlite
```

确认后重新审核和查询，仍满足条件才保存。拒绝用 `--decision reject`。含风险警告的建议需要 `--kinds risk_ack`；两种事项同时出现时，可以分别确认，或明确使用 `--kinds time_change,risk_ack`。

确认记录来自宿主 CLI，包含操作者、对象、版本、范围、决定和时间。模型没有“批准”工具。`--actor` / `SCHEDULER_ACTOR` 是本机可信操作者标识，不是生产身份认证。

`state` 返回 `fsmState`、`waitingFor`、待确认项、真实草稿及 `transitions`。正常保存经过 `checking → ready → saving → saved`；资料不足、等待确认、阻断与失败都有独立状态。`ready` 只是可保存，不能称为已保存。确认后回到 `checking` 复检，不直接跳到 `saved`。

## 资料补充与保存重试

```bash
npm run cli -- run --input data/inputs/missing.json --mode mock --db .runtime/missing.sqlite
npm run cli -- supplement --session SESSION_ID --input data/inputs/supplement.json --mode mock --db .runtime/missing.sqlite

npm run cli -- run --input data/inputs/normal.json --mode mock --fail-save always --db .runtime/failure.sqlite
npm run cli -- retry --session SESSION_ID --mode mock --db .runtime/failure.sqlite
```

补充文件包含 `materialId`、可选 `channel`、`source` 和 `fields`；允许补充 `title`、`text`、`rights`。补充会递增素材版本并使旧确认失效。合成资料源能自动补齐 M02，M06 需要用户补充。

`--fail-save always` 在 INSERT 后注入错误，验证事务回滚；该命令预期退出码为 2。`retry` 时省略故障参数即可恢复。每项每轮保存最多两次，是否重试由模型选择。

## Trace 观测

工具生命周期由 [Pi 扩展](src/extensions/trace.ts)通过 `pi.on("tool_execution_start")`、`pi.on("tool_execution_end")` 订阅采集。[业务工具](src/tools.ts)只负责业务调用、执行保护和结果返回，不写日志；JSONL 写入统一放在 `src/observability/trace.ts`。

日志用 `callId` 关联参数、结果和耗时，用 `sessionId` 关联确认前后的运行。工具事件带 `collector: "pi.on"` 和 `sdkEvent`。`ok` 同时考虑 SDK 执行异常与业务返回的 `ok:false`；`sdkIsError` 单独保留 SDK 标志。

模型请求在 Provider 边界记录，整次运行和草稿幂等复检由宿主记录。`step` 表示 SDK 调用尝试的顺序；`toolCalls` 统计进入受控执行的次数，被预算拒绝的尝试也会留下失败事件。默认文件为 `.runtime/traces/<runId>.jsonl`，可用 `--trace 路径` 指定。

## 真实模型接入

复制 `.env.example` 为本机 `.env`，填写支持 **OpenAI Chat Completions、SSE 和 function calling** 的服务信息。不要提交真实 Key。

```bash
npm run cli -- run --input data/inputs/normal.json --mode live --db .runtime/live.sqlite
npm run cli -- run --input data/inputs/conflict.json --mode live --db .runtime/live.sqlite
npm run smoke:live
npm run examples -- --mode live
```

`live` 是 CLI 默认模式；缺少配置会明确失败，不会自动变成 Mock。不同服务的兼容性应以实际运行结果为准。真实评估产物写入 `examples/live/`，提交前检查其内容和脱敏情况。

可选环境变量：`MODEL_MAX_TOKENS` 控制每次生成上限（默认 2048），`MODEL_CONTEXT_WINDOW` 声明模型上下文容量（默认 32000）；`MODEL_DISABLE_THINKING=true` 向支持该字段的服务发送 `thinking: {type: "disabled"}`，默认 false 不发送。温度保持服务默认，避免不兼容参数。

已验证的 Kimi 配置为 `https://api.moonshot.cn/v1`、`kimi-k2.6`、输出上限 1024、上下文 262144、关闭思考。运行真实模型时，需要填写自己的本机 `.env`；Key 不进入示例或交付文件。

截至 2026-10-28，Kimi 官方当前可用模型中，K2.6 与 K2.7 Code 普通版输入/输出单价同为每百万 Token ¥6.50 / ¥27.00；K2.6 缓存命中单价更低（¥1.10），且允许关闭思考，因此选择 K2.6。[官方定价](https://platform.kimi.com/docs/pricing/chat)、[非思考参数](https://platform.kimi.com/docs/guide/kimi-k2-6-quickstart)。官方计划 2026 年底下线 K2 系列，后续使用时需复核可用性。

早期真实小范围验证见 [状态记录](examples/live/validation-status.json)、[正常路径](examples/live/smoke-normal/trace.jsonl)、[冲突路径](examples/live/smoke-conflict/trace.jsonl)。最新完整11场景的一次运行见 [汇总](examples/live/summary.json) 与 [独立核对](examples/live/acceptance-review.json)，完整验收映射见 [评估](docs/03-evaluation.md)。单次通过不代表统计稳定性或真实业务数据审核效果。

`smoke:live` 在隔离数据和数据库上重跑两条真实路径，并保存状态迁移历史；会调用付费模型。`verify` 只执行本地测试与离线场景。

## 输入与状态

```json
{
  "requestId": "campaign-001",
  "items": [
    {"materialId":"M01","channel":"douyin","requirement":{"kind":"fixed","at":"2030-01-01T18:00:00+08:00"}}
  ]
}
```

可用时间窗口使用 `{"kind":"window","start":"2030-01-01T17:00:00+08:00","end":"2030-01-01T20:00:00+08:00"}`，起止均包含，跨度最多七天。一批 1–20 项；同素材、同渠道在一批中只能出现一次。时间为带 `+08:00` 或 `Z` 的有效整点。

省略 `requestId` 时按规范化输入生成稳定键。显式相同 ID 携带不同输入会拒绝。相同请求重跑复检并复用草稿；已保存草稿条件发生变化时明确阻断，保留原记录供人工处理。

输出分别给出审核状态、风险、原要求、建议时间、有效批准时间、待确认项和保存状态：`not_saved / saved / existing / failed`。`draft` 是真实数据库记录。保存成功只表示草稿已保存。

默认上限为每次运行 12 次模型决策、24 次工具调用、120 秒；可用 `--max-decisions`、`--max-tools`、`--timeout-ms` 设置。超限返回 `incomplete`，已完成记录保留；用同一输入重跑可继续剩余项。退出码：完成、等待输入、业务阻断为 0，运行失败或未完成为 2；应结合 `runStatus` 判断业务结果。

`data/materials.json` 是首次初始化台账；后续补充存入 SQLite。`data/rules.json` 和 `data/schedules.json` 在业务检查时重新读取，可用 `--data-dir` 指向复制后的数据目录验证占用变化。所有材料均为合成数据，2030 年日期用于稳定复现。
