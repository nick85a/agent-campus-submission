import test from "node:test";
import assert from "node:assert/strict";
import { fixture, at } from "./helpers.ts";
import { SchedulerService } from "../src/service.ts";
import { TerminalCheckpoint } from "../src/chat/terminal-checkpoint.ts";
import { validateMeaning } from "../src/chat/intake.ts";

test("按素材发现任务仅返回本人任务，不能自动选取他人会话", t => {
  const f = fixture(t), other = new SchedulerService(f.store, "other-user");
  other.open({ items: [{ materialId: "M06", channel: "douyin", requirement: { kind: "fixed", at: at(16) } }] });
  assert.equal(f.service.materialTasks("M06").tasks.length, 0);
  const own = f.service.open({ items: [{ materialId: "M06", channel: "douyin", requirement: { kind: "fixed", at: at(17) } }] });
  assert.deepEqual(f.service.materialTasks("M06").tasks.map(task => task.sessionId), [own.id]);
});
test("终端检查点按操作者与模式隔离，陈旧终端不能覆盖更新的对话", t => {
  const f = fixture(t), first = new TerminalCheckpoint(f.service, "live"), stale = new TerminalCheckpoint(f.service, "live");
  first.save({ pendingInput: "安排 M06" });
  assert.throws(() => stale.save({ pendingInput: "安排 M01" }), { code: "CHAT_SESSION_CHANGED" });
  assert.equal(new TerminalCheckpoint(f.service, "live").context?.pendingInput, "安排 M06");
  assert.equal(new TerminalCheckpoint(f.service, "mock").context, undefined);
  assert.equal(new TerminalCheckpoint(new SchedulerService(f.store, "other-user"), "live").context, undefined);
});
test("语义查询带素材证据时不能降级成全量清单，日期和时间可限定已有任务", () => {
  const context = { text: "帮我查一下 M06 的待办", now: new Date("2026-10-28T06:00:00Z"), materials: [{ id: "M06" }], timeoutMs: 1000 };
  assert.deepEqual(validateMeaning({ action: "pending", materialQuote: "M06" }, context), { kind: "material", materialId: "M06" });
  assert.deepEqual(validateMeaning({ action: "material", materialQuote: "M06", dateQuote: "2030-01-01", timeQuote: "17点", channelQuote: "抖音" }, { ...context, text: "继续 M06 原定2030-01-01 17点 抖音" }), { kind: "material", materialId: "M06", at: at(17), channel: "douyin" });
  assert.throws(() => validateMeaning({ action: "material", materialQuote: "M01" }, context), { code: "CHAT_UNGROUNDED_INPUT" });
  assert.throws(() => validateMeaning({ action: "schedule", materialQuote: "M06", dateQuote: "下个月某一天" }, { ...context, text: "安排 M06 下个月某一天" }), { code: "CHAT_INFORMATION_REQUIRED" });
});
