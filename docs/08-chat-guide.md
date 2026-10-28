# 08 业务聊天接口

## 启动

```bash
npm run api
```

服务默认仅监听本机 `127.0.0.1:8787`，使用 `.runtime/business-chat.sqlite`。可用 `-- --port 8788 --db .runtime/another.sqlite --mode mock` 调整；live 为默认模式并自动加载本机 .env。API Key 留在服务端。

## 发送业务消息

```bash
curl http://127.0.0.1:8787/api/chat \
  -H 'Content-Type: application/json' \
  -d '{"message":"把新品介绍放到2030年1月1日晚上六点，发抖音，帮我安排一下","requestId":"schedule-001"}'
```

真实模式由 Kimi 理解语义，可以按唯一素材标题识别 M01，将原文“晚上六点”核验为上海时间 18:00，再进入 Pi 审核与排期循环。原时间占用时建议 19:00，保持原要求不变，确认前无草稿。

响应包含：

- conversationId：后续对话使用的标识。
- message：面向业务用户的回复。
- status：completed / awaiting_input / blocked / failed / canceled / incomplete。
- materials：素材审核、风险原因、原要求、建议时段、待确认事项、保存结果及实际草稿凭据。
- confirmation：需要确认时返回的卡片，含 id、素材、建议时间、确认类型与警告。

后续提问携带实际返回的 conversationId：

```bash
curl http://127.0.0.1:8787/api/chat \
  -H 'Content-Type: application/json' \
  -d '{"conversationId":"替换为返回的conversationId","message":"怎么没有按我说的六点排呢？","requestId":"explain-001"}'
```

## 本人确认

用实际返回的标识替换下列占位符。action 代表用户针对确认卡片的明确选择，不由模型产生：

```bash
curl http://127.0.0.1:8787/api/chat \
  -H 'Content-Type: application/json' \
  -d '{"conversationId":"替换为返回的conversationId","requestId":"confirm-001","action":{"confirmationId":"替换为返回的confirmation.id","decision":"accept","kinds":["time_change"]}}'
```

风险接受使用 risk_ack；两类事项分别记录。拒绝使用 decision=reject。确认卡片绑定后台具体建议、版本、资料和规则依据；过期或伪造卡片不能批准。确认后重新检查时段和规则，满足条件才保存草稿。模型理解出的“同意”意图不会直接写确认；业务端需要卡片选择，或用户明确输入“同意改期”“接受风险”“拒绝当前建议”。

## 重复提交与会话恢复

发送“刚才那条再提交一次，别生成重复的草稿”，使用同一 conversationId 和新的 requestId。预期重新核验后 saveStatus=existing，草稿 ID 相同。

同一会话中相同 requestId、相同内容返回已完成响应；相同 ID 对应不同内容返回 409。要重新评估当前条件，使用新的消息 ID。业务上下文和确认卡片保存在 SQLite；对话消息由 Pi 原生 SessionManager 持久化，活跃对话复用同一个 AgentSession。服务重启后沿用 conversationId，恢复原 Pi 会话文件和消息历史。一个进程内同一会话请求串行执行。

模糊输入不会清掉有效建议。例如先提出19:00待确认，用户输入“统一”，系统追问是否同意当前改期；随后输入“同意”仍对应原建议，复检后才能保存。“统一”本身不会记成批准。只有一项待确认时也可输入“确认”；同时有时间和风险两项时仍需分别明确。新排期请求、明确拒绝、素材或建议版本变化继续阻止旧确认被沿用。

消息和 action 二选一，拒绝未知字段与客户端自报 actor；每条消息最多4000字，请求最多16KiB。错误响应使用业务提示，不返回堆栈或内部配置。无会话返回404，格式错误返回400，不支持的 Content-Type 返回415。

## 终端体验

```bash
npm run cli -- chat --mode live --db .runtime/chat.sqlite
```

逐条输入业务诉求即可。真实模式通过模型理解语义；离线 `--mode mock` 使用确定性语言替身，只证明流程。终端与 HTTP 共用业务控制器，回复只展示审核、风险、建议、确认和草稿结果。

终端每轮保存当前任务、未补齐输入、确认卡片与 Pi 原生文件的关联；使用同一数据库、actor 与模式重启会自动恢复。已有多个终端时，陈旧检查点不能覆盖另一终端的新进度。升级前只有业务任务、没有终端检查点时，可输入“查询待处理清单 m06”“查看 M06”或直接“M06”定位。唯一未完成任务也可通过明确的“补充M06标题为双十一优惠”继续，无需重填日期时间；多个任务会要求说明原定日期、时间与渠道，例如“查看 M06 2030-01-01 17:00 渠道 douyin”。

支持“本周一”“下周一”“下下周日”等明确周次，以上海时间和周一为每周起点换算。进入排期后会展示具体年月日。单独“周一”等模糊日期仍要求说明；不会先猜日期再保存。“发布”会直接说明系统未接入真实发布。

资料不足时可以说“给 M06 补上标题‘补充后的教程’，已经获得授权”；关键资料必须有原文依据，无法明确识别时追问，不把来源或“我拍的”推断成授权。日期不足会追问，半点、截止时间和范围不被改为固定整点。当前自然语言排期逐项处理；批量和时间窗口可继续使用 JSON CLI。

当前 M06 等待补资料时，无需重复素材 ID 或日期时间，可以逐条输入“标题叫做双十一优惠 授权”“素材为双十一优惠”“已授权”。前两条只接收明确标题，继续追问授权，授权未知时不保存；第三条明确授权后重新审核，满足条件才按原定时间保存。这里的单词“授权”不能等同于“已授权”。素材对象可来自当前业务会话，标题、内容和授权的新值仍须来自本轮输入；模型不能沿用旧轮次的授权或写到用户明确指定的其他素材。

## 运维与验证

业务接口没有日志查询路由，不在回复中返回 Trace、模型调用次数、工具参数、内部会话或数据库字段。后台仍通过 pi.on 收集工具生命周期；运维可直接在本机 .runtime/traces 和 .runtime/chats 检查记录。Pi 会话消息文件位于 .runtime/pi-chat，按数据库与操作者隔离，文件权限0600；业务回复通过原生 sendCustomMessage 写回同一模型会话，不触发额外模型请求。业务会话标识与确认卡片只用于业务对话和授权。

运行 `npm run verify`，包含 API 路由、会话恢复、消息幂等、原文核验、模型不能代批与响应隔离测试，以及离线接口示例。

`npm run smoke:business-chat` 实际调用 Kimi。证据见 [请求与业务响应](../examples/business-chat/live/http-records.json)、[独立草稿核对](../examples/business-chat/live/outcome.json)、[验证结果](../examples/business-chat/live/validation.json)。admin-traces 为后台观测证据，未通过业务接口返回。所有资料为合成数据，自动确认是标注的测试夹具，不是真实人工审批。

`npm run smoke:business-chat -- --scenario information` 还验证了逐轮补齐日期、中文时间、缺失标题和明确授权，再重新审核保存。实际对话见 [资料补充记录](../examples/business-chat/live/information/http-records.json)。

`npm run smoke:business-chat -- --scenario default-channel` 回归原句“把 M01 安排在2030年1月1日晚上六点”。未提渠道时使用业务默认抖音，即使模型误回填默认值也不会误拒；用户明确指定其他渠道时仍核对原文，不能擅自覆盖。

`npm run smoke:business-chat -- --scenario session-context` 验证“排期→统一→同意→查询刚才安排”。该示例在澄清后重建 HTTP 服务，核对 Pi 原生 sessionId 仍相同、历史可恢复、确认卡片未丢失且只保存一份草稿。运行证据见 [对话记录](../examples/business-chat/live/session-context/http-records.json)、[Pi 会话核对](../examples/business-chat/live/session-context/pi-session-proof.json)。其中同意是程序测试输入。

`npm run smoke:business-chat -- --scenario supplement-context` 回归上述省略素材 ID 的补资料原句。实际 [对话记录](../examples/business-chat/live/supplement-context/http-records.json) 与 [补资料前后存储核对](../examples/business-chat/live/supplement-context/supplement-proof.json) 分别核对标题、未知授权、原定17:00和最终唯一草稿；全部资料为合成数据，授权陈述由测试客户端发送。

本地演示采用服务端配置的可信 actor；不提供生产身份认证、跨多个服务进程的对话锁或线上部署。当前不自动压缩长对话，超过模型上下文窗口时明确失败，不清空历史冒充完成。只保存草稿，不连接真实发布。

`npm run smoke:terminal-recovery` 通过三个真实 CLI 进程验证跨进程恢复，实际记录见 [终端对话](../examples/chat/live-terminal-recovery/terminal-records.json)、[存储核对](../examples/chat/live-terminal-recovery/outcome.json) 和 [验证结果](../examples/chat/live-terminal-recovery/validation.json)。使用合成素材，授权是程序输入。
