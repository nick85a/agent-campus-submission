# 03 评估

## 实际验证入口

运行 `npm run verify`。完整输出与版本信息位于 [verification.json](../examples/checks/verification.json)、[测试原始输出](../examples/checks/tests.stdout.txt)、[类型检查](../examples/checks/typecheck.stdout.txt) 和 [依赖审计](../examples/checks/audit.stdout.txt)。

下列输出来自实际执行同一 Pi SDK 循环和 SQLite 业务代码的 **离线 Mock**。每个目录均有 input、初始数据、output、JSONL Trace、state-history 和 outcome。outcome 包含真实查询得到的最终草稿；state-history 直接查询数据库审计，不由模型编写。脚本执行的确认另有 `automatedFixture` 标记，不冒充真实人工操作。

| 验收项 | 预期 | 实际证据 |
|---|---|---|
| 正常排期 | M01 在可用 17:00 保存，返回草稿凭据 | [输出](../examples/mock/01-normal/output.json)、[Trace](../examples/mock/01-normal/trace.jsonl)、[存储](../examples/mock/01-normal/outcome.json) |
| 素材缺失 | M06 补查无结果时等待；补充后重新审核保存 | [首次](../examples/mock/02-missing/output.json)、[补充后](../examples/mock/02-missing/after-supplement.output.json)、[Trace](../examples/mock/02-missing/after-supplement.trace.jsonl) |
| 规则风险 | 警告需确认，拒绝授权的素材阻断 | [警告](../examples/mock/03-risk-warning/output.json)、[阻断](../examples/mock/04-risk-blocked/output.json) |
| 时段冲突 | 保留原要求 18:00，建议 19:00，确认前不保存 | [确认前](../examples/mock/05-conflict-confirm/output.json)、[确认后](../examples/mock/05-conflict-confirm/after-confirm.output.json)、[Trace](../examples/mock/05-conflict-confirm/trace.jsonl) |
| 重复提交 | 相同草稿 ID，只有一份记录 | [首次](../examples/mock/07-duplicate/output.json)、[重复](../examples/mock/07-duplicate/repeat.output.json)、[最终存储](../examples/mock/07-duplicate/outcome.json) |
| 保存失败 | 两次失败后明确 failed，事务无残留；恢复后一份草稿 | [失败](../examples/mock/06-save-failure/output.json)、[失败时存储](../examples/mock/06-save-failure/failure-outcome.json)、[恢复后](../examples/mock/06-save-failure/after-retry.output.json) |
| 占用变更 | 改为 19:00 占用后重新选择原要求 18:00 | [新占用](../examples/mock/09-changed-occupancy/replacement-schedules.json)、[重跑](../examples/mock/09-changed-occupancy/after-change.output.json)、[Trace](../examples/mock/09-changed-occupancy/after-change.trace.jsonl) |
| 自动补查 | M02 从补充源补齐标题，再审核保存 | [输出](../examples/mock/08-supplement-source/output.json)、[Trace](../examples/mock/08-supplement-source/trace.jsonl) |
| 执行预算 | 达上限明确 incomplete，无虚构成功 | [输出](../examples/mock/10-execution-limit/output.json)、[Trace](../examples/mock/10-execution-limit/trace.jsonl) |
| 批次避让 | 同批素材建议时段互相避让 | [输出](../examples/mock/11-batch/output.json)、[Trace](../examples/mock/11-batch/trace.jsonl) |

## 可执行断言

终端重启回归：此前 HTTP 保存了业务上下文，但终端只保存 Pi 消息文件，没有把当前任务与原生文件关联恢复，导致重启后“补充M06”提示未选素材；逐项查询也缺少 material 意图。现已增加按操作者和模式隔离的检查点、唯一未完成任务定位、多个任务拒绝自动选择、无任务不猜时间，并验证陈旧终端不能覆盖新进度。真实 Kimi [三个 CLI 进程的对话](../examples/chat/live-terminal-recovery/terminal-records.json)、[实际台账及草稿](../examples/chat/live-terminal-recovery/outcome.json)、[验证结果](../examples/chat/live-terminal-recovery/validation.json) 记录了下周一17:00、重启后定位M06与补标题、再次重启明确授权后保存。原生 Pi Session ID 相同，只有一个业务任务和一份草稿。授权陈述由测试程序输入，不是真人审批。

补资料截图回归：实际本机记录显示模型已选择 supplement，却把来自当前会话的 M06 当成本轮原文引用，宿主因此错误拒绝；“授权”本身也未明确授权状态。修复后允许补资料对象沿用宿主当前项，显式其他素材仍拒绝；标题先保存到素材台账并重新审核，授权未知时保持未保存，只在本轮明确授权后继续。首次真实回归还发现补资料澄清会被当成新排期，导致当前素材返回被遮蔽；[失败记录](../examples/business-chat/live/supplement-context/failed-attempt/failure.json) 和 [当次请求响应](../examples/business-chat/live/supplement-context/failed-attempt/http-records.json) 已保留，补资料追问现使用独立错误类型。验证包含跨素材、伪造字段、历史授权不能复用的断言，以及真实 Kimi [输入与响应](../examples/business-chat/live/supplement-context/http-records.json)、[实际存储核对](../examples/business-chat/live/supplement-context/supplement-proof.json) 和 [结果](../examples/business-chat/live/supplement-context/validation.json)。新场景不包含改期或风险确认，授权陈述是测试输入。

聊天验证见 [聊天验收](08-chat-guide.md)。新增解析、控制器和独立 CLI 测试，覆盖上海时区、追问、模糊同意、确认范围、过期建议、资料补充、失败恢复、断开后恢复、管道输入缓冲及日志脱敏。离线记录另存于 [examples/chat/mock](../examples/chat/mock/summary.json)；旧终端版本的历史记录保存在 [legacy-live](../examples/chat/legacy-live/summary.json)，含早期调试输出；当前业务接口证据见下文。

业务 HTTP 验证进一步覆盖模型语义理解的原文约束、禁止模型代批、确认卡片、跨请求恢复、消息幂等和响应字段隔离。实际请求/响应见 [真实业务聊天记录](../examples/business-chat/live/http-records.json)，独立草稿核对见 [存储结果](../examples/business-chat/live/outcome.json)，后台观测保存在同目录 admin-traces。接口响应只返回业务结果，查询运行日志的请求不会得到日志。

用户反馈原句“把 M01 安排在2030年1月1日晚上六点”被误拒：模型将默认“抖音”放入原文引用，严格引用校验因此失败。已修复为缺省渠道由业务层决定，明确渠道仍须原文依据；新增单测覆盖模型省略或回填默认值、幻造其他渠道、用户明确指定其他渠道。真实原句回归见 [HTTP 记录](../examples/business-chat/live/default-channel/http-records.json) 与 [验证](../examples/business-chat/live/default-channel/validation.json)。

截图反馈“统一→同意”后建议丢失，根因包括每轮重建模型会话和模糊输入清空有效确认。现由原生 Pi AgentSession 保留完整对话并记录真实业务回复，HTTP 重启通过 SessionManager.open 恢复同一历史；模糊输入只澄清，不撤回有效建议。协议测试替身断言后续模型请求实际包含之前的用户消息和业务回复，并核对会话文件权限；真实模型证据见 [session-context](../examples/business-chat/live/session-context/validation.json)。

业务测试验证：资料不足、禁止风险、不同确认范围、旧版本确认、规则变更、用户拒绝、保存前冲突、原始要求保持、已有草稿占用与自身排除、稳定键、请求 ID 冲突、事务回滚和重启恢复。

状态机与统一入口测试验证：禁止跳过 ready/saving 声称成功、缺少依据不能迁移、ready 不能结束为已完成、本人同意后返回 checking 复检、agent 来源不能确认或自由改资料、未知命令不能执行，以及失败回滚不会留下虚假的成功迁移。正常状态历史见 [state-history.json](../examples/mock/01-normal/state-history.json)，失败恢复历史见 [state-history.json](../examples/mock/06-save-failure/state-history.json)。

Agent 测试验证真实 Pi SDK 工具循环、不同观察下的动作分支、候选时段再次占用、保存失败与有界重试、无可用时段、未知素材、预算耗尽后的继续处理，以及已有草稿失效时阻断。

单项恢复测试保证：confirm/supplement/retry 只处理选中项时，会话中的其他 checking/ready/saving 项仍使整体返回 incomplete；用相同输入重跑继续，已保存项复用原草稿，不虚报整批完成。

风险与时间确认组合测试还验证：只接受 19:00 的 risk_ack 后，18:00 恢复可用时必须重新请求针对 18:00 的风险确认，不能沿用旧同意。

CLI 测试启动独立进程验证并发去重，以及 run → show → confirm → 重复提交。Provider 测试用本地 HTTP/SSE 测试替身验证真实适配器的工具协议、缺配置失败、模型空口宣称成功不产生草稿、服务挂起被超时取消。**Provider 测试替身仍不是真实模型。**

Trace 测试验证 Pi 扩展订阅确实采集开始和结束事件、callId 一一对应、步骤和素材上下文正确、业务失败与 SDK 异常分别标记，以及预算拒绝的调用仍可追溯。示例工具事件的 `collector` 为 `pi.on`，保留原有事件名和结果字段。

## 真实模型验证状态

最新完整场景运行由用户执行 `npm run examples -- --mode live`，模型为 Kimi K2.6。原始 [场景汇总](../examples/live/summary.json) 记录11项通过；AI随后独立核对首轮及恢复后的输出、16份Trace、78次Pi工具调用，并以只读方式核对11个临时SQLite数据库中的草稿、会话、确认和状态迁移，共181项检查通过。详见 [核对报告](../examples/live/acceptance-review.json)，该报告记录既有产物的核对结果，未重新调用模型，也未修改原始运行产物。

| 本次真实模型场景 | 实际结果 | 证据 |
|---|---|---|
| 正常排期 | 原定17:00保存1份草稿 | [输出](../examples/live/01-normal/output.json) |
| 信息不足及补充 | 首轮等待且无草稿；夹具补标题、授权后重审保存1份 | [首轮](../examples/live/02-missing/output.json)、[补充后](../examples/live/02-missing/after-supplement.output.json) |
| 警告风险 | 等待risk_ack，无草稿 | [输出](../examples/live/03-risk-warning/output.json) |
| 禁止风险 | 授权被拒绝，阻断且无草稿 | [输出](../examples/live/04-risk-blocked/output.json) |
| 冲突及确认 | 18:00占用，建议19:00；夹具确认前无草稿，确认后保存1份 | [确认前](../examples/live/05-conflict-confirm/output.json)、[确认后](../examples/live/05-conflict-confirm/after-confirm.output.json) |
| 保存失败及恢复 | 两次实际SAVE_FAILED后结束为failed，当时无草稿；恢复后保存1份 | [失败快照](../examples/live/06-save-failure/failure-outcome.json)、[恢复](../examples/live/06-save-failure/after-retry.output.json) |
| 重复提交 | 返回相同草稿ID、existing，数据库仅1份 | [重复结果](../examples/live/07-duplicate/repeat.output.json) |
| 自动补查 | M02缺标题，从补充源查到后重新审核保存 | [Trace](../examples/live/08-supplement-source/trace.jsonl) |
| 更换占用 | 将占用改为19:00后，重新选择恢复可用的原定18:00保存 | [重跑](../examples/live/09-changed-occupancy/after-change.output.json) |
| 执行超限 | 达到2次模型决策后runStatus=incomplete，素材保留ready，无草稿 | [输出](../examples/live/10-execution-limit/output.json) |
| 批次避让 | M01建议19:00、M05建议20:00；均待确认，无草稿 | [输出](../examples/live/11-batch/output.json) |

本次符合题目要求的六类场景和至少两条模型动态决策路径：正常时选择保存；发现冲突时选择确认；补查无结果时等待资料；保存失败后只重试一次再结束。每个场景目录含输入、初始数据、实际输出、Trace、最终存储及状态历史。Trace的reason是公开动作依据，不是内部思维。

解释边界：摘要中的passed主要描述首轮状态，本次另行核验了全部恢复结果与数据库，未仅凭该标志判定通过。超限场景expectedStatus=incomplete指整次运行，actualStatus=ready指素材进度，不构成失败。重复提交走宿主幂等快路径，0次模型调用不作为ReAct证据。测试授权和确认是自动夹具；合成工具数据不会证明真实音视频审核效果。本次只完成固定样例的一次运行，尚无多次运行一致性、真实人工审批或生产数据评测。

首次交付未提供模型配置。后续用户授权配置 Kimi API，选择 `kimi-k2.6` 非思考模式，设置单次最大输出 1024 Token，已完成两条真实模型小范围验证。见 [状态记录](../examples/live/validation-status.json)。

| 真实模型路径 | 实际结果 | 证据 |
|---|---|---|
| 正常排期 | 保存 1 份草稿；实际请求/工具次数见输出 | [输出](../examples/live/smoke-normal/output.json)、[Trace](../examples/live/smoke-normal/trace.jsonl)、[存储](../examples/live/smoke-normal/outcome.json) |
| 时段冲突 | 等待确认且草稿为 0 份；实际请求/工具次数见输出 | [输出](../examples/live/smoke-conflict/output.json)、[Trace](../examples/live/smoke-conflict/trace.jsonl)、[存储](../examples/live/smoke-conflict/outcome.json) |

请求使用真实服务和真实模型返回，工具仍为本地合成业务实现。上述两条 smoke:live 不包含脚本确认。实际 Key 未进入证据或交付副本。通过 `npm run smoke:live` 可在隔离数据库中复跑这两条路径，同时生成状态历史。新增聊天入口另通过 smoke:chat 验证冲突、夹具模拟确认、保存与重复提交；模拟确认明确标注，不是真实人工审批。最新11场景的范围及结果见本节前半部分。

可用 `npm run examples -- --mode live` 复跑11场景。评估应检查真实工具调用和数据库结果，不能只看模型文字。建议固定同一组初始数据，多次运行统计一致性；本次不报告未经采集的稳定成功率或实际扣费金额。
