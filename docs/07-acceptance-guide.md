# 07 手工验收流程

运行目录为项目根目录，需要 Node.js ≥22.19。先执行 `npm ci --ignore-scripts`、`npm run verify`，查看 examples/checks/verification.json。自动测试包含六项必验、统一入口权限、状态机、并发、预算与 Trace。

## 准备隔离环境

```bash
mkdir -p .runtime
SCHED_TEST_DIR=$(mktemp -d "$PWD/.runtime/acceptance.XXXXXX")
cp -R data "$SCHED_TEST_DIR/data"
```

每个用例使用独立数据库。下文 SESSION_ID、PROPOSAL_ID、VERSION 使用实际输出替换。

## 六项必验

| 验收 | 执行与核对 |
|---|---|
| 正常排期 | normal.json → saved，draft 有真实 ID，状态历史含 ready/saving/saved |
| 信息缺失 | missing.json → needs_information；supplement 后重新审核，才可保存 |
| 规则风险 | risk.json → needs_confirmation/risk_ack；blocked.json → blocked，不能确认豁免 |
| 时段冲突 | conflict.json → 原要求 18:00、建议 19:00，确认前 draft=null |
| 重复提交 | 相同输入与数据库重跑，返回 existing、原 draft.id，草稿仍只有一份 |
| 保存失败 | --fail-save always → failed、draft=null，无 save_succeeded；去掉故障后 retry |

```bash
npm run cli -- run --input data/inputs/normal.json --mode mock --db "$SCHED_TEST_DIR/normal.sqlite"
npm run cli -- run --input data/inputs/missing.json --mode mock --db "$SCHED_TEST_DIR/missing.sqlite"
npm run cli -- run --input data/inputs/risk.json --mode mock --db "$SCHED_TEST_DIR/risk.sqlite"
npm run cli -- run --input data/inputs/blocked.json --mode mock --db "$SCHED_TEST_DIR/blocked.sqlite"
npm run cli -- run --input data/inputs/conflict.json --mode mock --db "$SCHED_TEST_DIR/conflict.sqlite"
```

查询缺失项、状态和确认记录：

```bash
npm run cli -- state --session SESSION_ID --material M01 --channel douyin --db "$SCHED_TEST_DIR/conflict.sqlite"
npm run cli -- confirm --session SESSION_ID --material M01 --channel douyin --proposal PROPOSAL_ID --version VERSION --kinds time_change --decision accept --mode mock --db "$SCHED_TEST_DIR/conflict.sqlite"
npm run cli -- run --input data/inputs/conflict.json --mode mock --db "$SCHED_TEST_DIR/conflict.sqlite"
```

确认命令先记录本人决定，再进入 Pi 重新检查。风险确认使用 risk_ack，时间变更使用 time_change；两类确认分别生效。要测试拒绝，使用新数据库重跑后选择 reject，预期 canceled 且没有草稿。

```bash
npm run cli -- supplement --session SESSION_ID --input data/inputs/supplement.json --mode mock --db "$SCHED_TEST_DIR/missing.sqlite"
npm run cli -- run --input data/inputs/normal.json --mode mock --fail-save always --db "$SCHED_TEST_DIR/failure.sqlite"
npm run cli -- retry --session SESSION_ID --mode mock --db "$SCHED_TEST_DIR/failure.sqlite"
```

保存失败与预算超限的退出码 2 是预期现象；等待输入、业务阻断的退出码为 0，应结合 runStatus、saveStatus 和实际草稿判断结果。

## 更换占用再重复提交

```bash
npm run cli -- run --input data/inputs/conflict.json --mode mock --data-dir "$SCHED_TEST_DIR/data" --db "$SCHED_TEST_DIR/change.sqlite"
printf '%s\n' '[{"channel":"douyin","at":"2030-01-01T19:00:00+08:00","materialId":"BUSY19"}]' > "$SCHED_TEST_DIR/data/schedules.json"
npm run cli -- run --input data/inputs/conflict.json --mode mock --data-dir "$SCHED_TEST_DIR/data" --db "$SCHED_TEST_DIR/change.sqlite"
```

首次 18:00 被占用，应提出 19:00 待确认；更换后 18:00 恢复可用，应按原要求保存 18:00，旧 19:00 建议失效。也可先同意 19:00，再把它设为占用，验证复检后不会保存该时段。

## Trace 与真实模型

每次输出给出 tracePath。工具事件应有 collector=pi.on、配对 callId、参数、公开 reason、业务结果和耗时；业务状态历史由 state/show 和 state-history.json 提供。

`npm run smoke:live` 使用已配置 API 重新验证正常与冲突两条真实路径，会产生模型费用。`npm run examples -- --mode live` 运行完整场景；示例脚本中的确认是显式标注的自动化夹具。Mock 只证明流程，不能替代真实模型效果。
