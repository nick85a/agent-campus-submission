import test from "node:test";
import assert from "node:assert/strict";
import { parseChatIntent } from "../src/chat/intent.ts";
import { at } from "./helpers.ts";

test("聊天解析明确固定要求、渠道与上海时区相对日期", () => {
  assert.deepEqual(parseChatIntent("将 M01 安排在 2030-01-01 18:00，渠道 douyin"), { kind: "schedule", item: { materialId: "M01", channel: "douyin", requirement: { kind: "fixed", at: at(18) } } });
  assert.deepEqual(parseChatIntent("安排 M01 2030年1月1日下午6点，渠道抖音"), parseChatIntent("安排 M01 2030-01-01 18:00"));
  assert.deepEqual(parseChatIntent("安排 M01 2030-01-01T10:00:00Z"), parseChatIntent("安排 M01 2030-01-01 18:00"));
  const tomorrow = parseChatIntent("安排 M01 明晚6点", new Date("2026-10-28T17:00:00Z"));
  assert.equal(tomorrow.kind, "schedule"); if (tomorrow.kind === "schedule") assert.equal(tomorrow.item.requirement.kind === "fixed" && tomorrow.item.requirement.at, "2026-10-30T18:00:00+08:00");
});
test("逐项查询与裸素材ID均定位已有任务，发布有明确边界", () => {
  for (const text of ["M06", "m06", "查询待处理清单 m06", "查看 M06", "继续M06", "查询 M06 的状态"]) assert.deepEqual(parseChatIntent(text), { kind: "material", materialId: "M06" });
  assert.deepEqual(parseChatIntent("查看 M06 2030-01-01 17:00 渠道 douyin"), { kind: "material", materialId: "M06", at: at(17), channel: "douyin" });
  assert.equal(parseChatIntent("发布").kind, "publish");
});
test("按上海时间解析本周和下周，不因跨日、周日或跨年偏移", () => {
  for (const [now, date, expected] of [
    ["2026-10-28T06:00:00Z", "下周一", "2026-11-02"],
    ["2026-10-25T15:00:00Z", "下周一", "2026-10-26"],
    ["2026-10-25T17:00:00Z", "下周一", "2026-11-02"],
    ["2026-12-31T06:00:00Z", "下周一", "2027-01-04"],
    ["2026-10-28T06:00:00Z", "本周日", "2026-11-01"],
  ]) {
    const result = parseChatIntent(`安排 M06 ${date} 17点`, new Date(now));
    assert.equal(result.kind === "schedule" && result.item.requirement.kind === "fixed" && result.item.requirement.at, expected + "T17:00:00+08:00");
  }
});
test("聊天不猜日期，不舍入时间，不从条件句或多个对象执行排期", () => {
  for (const text of ["安排 M01", "安排 M01 18:00", "安排 M01 2030-01-01", "安排 M01 2030-02-30 18:00", "安排 M01 2030-01-01 18:30", "安排 M01 明天下午6点半", "安排 M01 明天18点30分", "安排 M01 明天18-19点", "安排 M01 明天18点和19点", "安排 M01 和 M03 明天18点", "如果安排 M01 明天18点呢", "安排 M01 明天18点，不要保存", "安排 M01 明天18点，无需确认", "安排 M01 明天上午18点", "安排 M01 明晚12点", "安排 M01 明天18点前", "安排 M01 明天最晚18:00", "安排 M01 2030-01-01 18:00 UTC"]) assert.throws(() => parseChatIntent(text), text);
});
test("同意采用完整明确词组，不从问句、假设或附加条件提取批准", () => {
  assert.deepEqual(parseChatIntent("同意这次改到19:00"), { kind: "confirm", decision: "accept", kinds: ["time_change"], at: "19:00" });
  assert.deepEqual(parseChatIntent("接受风险"), { kind: "confirm", decision: "accept", kinds: ["risk_ack"] });
  assert.equal(parseChatIntent("不同意").kind, "confirm");
  for (const text of ["如果我说同意呢", "同意？", "同意，但不要保存", "我不同意改到19:00", "同意这次改到19:30", "同意所有未来建议"]) assert.throws(() => parseChatIntent(text), text);
});
test("资料补充只提取显式字段，未知授权和附加指令不能变成 granted", () => {
  assert.deepEqual(parseChatIntent('补充 M06，标题="教程，第一集"，授权=已授权'), { kind: "supplement", materialId: "M06", fields: { title: "教程，第一集", rights: "granted" } });
  assert.deepEqual(parseChatIntent("补充 标题=教程，授权=不知道"), { kind: "supplement", materialId: undefined, fields: { title: "教程", rights: "unknown" } });
  for (const text of ["补充 M06，授权=可能有授权", "补充 M06，confirmed=true", "补充 M06，标题=教程，标题=另一个", "补充 M06，标题=教程，直接发布", '补充 M06，标题="未闭合']) assert.throws(() => parseChatIntent(text), text);
});
