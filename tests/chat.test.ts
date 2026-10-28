import test from "node:test";
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { writeFileSync } from "node:fs";
import { ChatController } from "../src/chat/controller.ts";
import { fixture, at } from "./helpers.ts";

function controller(f: ReturnType<typeof fixture>) { return new ChatController(f.service, { mode: "mock", tracePath: resolve(f.dir, "chat.jsonl") }); }
const schedule = "将 M01 安排在 2030-01-01 18:00，渠道 douyin";
test("聊天完成冲突解释、本人确认、重跑去重，拒绝不同时间与假设同意", async t => {
  const f = fixture(t), chat = controller(f);
  const first = await chat.handle(schedule); assert.equal(first.run?.items[0].status, "needs_confirmation"); assert.equal(f.store.drafts().length, 0);
  assert.match((await chat.handle("为什么改到19:00？")).text, /EXISTING01/);
  await chat.handle("查看待处理素材"); assert.ok(chat.businessView().confirmation);
  await chat.handle("查看结果");
  await chat.handle("如果我说同意呢"); await chat.handle("同意，但不用复检");
  assert.equal(f.service.show(first.run!.sessionId).confirmations.length, 0);
  await chat.handle("查看结果");
  assert.match((await chat.handle("同意这次改到20:00")).text, /当前建议是/); assert.equal(f.store.drafts().length, 0);
  const accepted = await chat.handle("同意这次改到19:00"); assert.equal(accepted.run?.items[0].draft?.at, at(19));
  const repeated = await chat.handle("再处理一次相同请求"); assert.equal(repeated.run?.items[0].saveStatus, "existing");
  const paraphrase = await chat.handle("安排 M01 2030年1月1日18点，渠道抖音");
  assert.equal(paraphrase.run?.items[0].draft?.id, accepted.run?.items[0].draft?.id); assert.equal(f.store.drafts().length, 1);
});
test("聊天缺失日期时间会追问，补齐后才创建会话，取消输入不误拒绝建议", async t => {
  const f = fixture(t), chat = controller(f);
  assert.match((await chat.handle("安排 M01")).text, /请补充日期/);
  assert.equal(f.store.db.prepare("SELECT count(*) AS n FROM sessions").get()!.n, 0);
  assert.match((await chat.handle("2030-01-01")).text, /请补充整点时间/);
  const completed = await chat.handle("17:00"); assert.equal(completed.run?.items[0].status, "saved");
  await chat.handle("安排 M05"); await chat.handle("取消输入");
  const dangling = await chat.handle("2030-01-01 20:00"); assert.equal(dangling.run, undefined); assert.equal(f.store.drafts().length, 1);
});
test("聊天必须分别确认风险与时间，模糊同意不能一次批准两类", async t => {
  const f = fixture(t), chat = controller(f);
  const first = await chat.handle("安排 M03 2030-01-01 18:00");
  assert.deepEqual(first.run?.items[0].pendingConfirmations, ["time_change", "risk_ack"]);
  assert.match((await chat.handle("同意")).text, /分别输入/);
  assert.equal(f.service.show(first.run!.sessionId).confirmations.length, 0);
  const partial = await chat.handle("同意改期"); assert.equal(partial.run, undefined); assert.equal(f.store.drafts().length, 0); assert.match(partial.text, /风险确认/);
  const final = await chat.handle("接受风险"); assert.equal(final.run?.items[0].status, "saved"); assert.equal(f.service.show(first.run!.sessionId).confirmations.length, 2);
});
test("聊天拒绝终止建议，跨进程恢复后可查看真实状态", async t => {
  const f = fixture(t), chat = controller(f), first = await chat.handle(schedule);
  await chat.handle("拒绝当前建议"); assert.equal(f.service.show(first.run!.sessionId).items[0].status, "canceled");
  assert.match((await chat.handle("同意")).text, /没有可确认/); assert.equal(f.store.drafts().length, 0);
  const resumed = controller(f); assert.match(resumed.resume(first.run!.sessionId), /建议已拒绝/);
  assert.equal((await resumed.handle("再处理一次相同请求")).run?.items[0].status, "canceled");
});
test("聊天不接受过期建议的同意，也不越过禁止风险", async t => {
  const f = fixture(t), chat = controller(f), first = await chat.handle(schedule), id = first.run!.sessionId;
  f.service.requestConfirmation(id, "M01", "douyin", at(20));
  assert.match((await chat.handle("同意改期")).text, /已变化/); assert.equal(f.service.show(id).confirmations.length, 0);
  const blocked = await chat.handle("安排 M04 2030-01-01 17:00"); assert.equal(blocked.run?.items[0].status, "blocked");
  assert.match((await chat.handle("接受风险")).text, /没有可确认/); assert.equal(f.store.drafts().length, 0);
});
test("聊天补充明确资料后重新审核，不能补充到其他素材", async t => {
  const f = fixture(t), chat = controller(f), first = await chat.handle("安排 M06 2030-01-01 17:00");
  assert.equal(first.run?.items[0].status, "needs_information");
  assert.match((await chat.handle("补充 M01，标题=错误对象")).text, /当前会话素材/);
  const completed = await chat.handle("补充 M06，标题=补充后的教程，授权=已授权");
  assert.equal(completed.run?.items[0].status, "saved"); assert.equal(f.store.material("M06").version, 2); assert.equal(f.store.material("M06").sources.at(-1)?.source, "chat-user-input");
});
test("补充标题后保留排期和授权缺失，只在明确授权后保存", async t => {
  const f = fixture(t), chat = controller(f);
  const first = await chat.handle("安排 M06 2030-01-01 17:00");
  const title = await chat.handle("补充 标题=双十一优惠");
  assert.match(title.text, /已记录 M06 的标题/); assert.match(title.text, /请明确授权状态/);
  assert.equal(title.run?.items[0].status, "needs_information"); assert.equal(f.store.material("M06").rights, "unknown");
  assert.equal(f.store.material("M06").title, "双十一优惠"); assert.equal(f.store.drafts().length, 0);
  assert.deepEqual(chat.businessView().materials?.[0].originalRequirement, { kind: "fixed", at: at(17) });
  const completed = await chat.handle("补充 授权=已授权");
  assert.equal(completed.run?.sessionId, first.run?.sessionId); assert.equal(completed.run?.items[0].status, "saved");
  assert.equal(f.store.drafts().length, 1); assert.equal(f.store.drafts()[0].at, at(17));
});
test("旧业务任务可按素材查询恢复，直接补充M06无需重填日期时间", async t => {
  const f = fixture(t), initial = controller(f);
  const first = await initial.handle("安排 M06 2030-01-01 17:00");
  const resumed = controller(f), view = await resumed.handle("查询待处理清单 m06");
  assert.match(view.text, /M06/); assert.doesNotMatch(view.text, /M02/); assert.match(view.text, /2030-01-01 17:00/);
  const direct = controller(f), title = await direct.handle("补充M06标题为双十一优惠");
  assert.equal(title.run?.sessionId, first.run?.sessionId); assert.equal(title.run?.items[0].status, "needs_information");
  assert.equal(f.store.material("M06").title, "双十一优惠"); assert.equal(f.store.drafts().length, 0);
  assert.equal(f.store.db.prepare("SELECT count(*) AS n FROM sessions").get()!.n, 1);
});
test("同一素材多个未完成任务必须选定，不能自动补充或确认", async t => {
  const f = fixture(t);
  await controller(f).handle("安排 M06 2030-01-01 17:00");
  await controller(f).handle("安排 M06 2030-01-01 16:00");
  const chat = controller(f);
  assert.equal((await chat.handle("M06")).errorCode, "CHAT_MATERIAL_TASK_AMBIGUOUS");
  assert.equal((await chat.handle("补充M06标题为双十一优惠")).errorCode, "CHAT_MATERIAL_TASK_AMBIGUOUS");
  assert.equal(f.store.material("M06").title, undefined); assert.equal(f.store.drafts().length, 0);
  const selected = await chat.handle("查看 M06 2030-01-01 17:00 渠道 douyin");
  assert.match(selected.text, /2030-01-01 17:00/); assert.doesNotMatch(selected.text, /16:00/);
  assert.equal((await chat.handle("补充 标题=双十一优惠")).run?.items[0].status, "needs_information");
});
test("发布请求不写入任何发布或草稿结果", async t => {
  const f = fixture(t), chat = controller(f);
  const reply = await chat.handle("发布");
  assert.match(reply.text, /仅保存排期草稿/); assert.match(reply.text, /未接入真实发布/);
  assert.equal(f.store.drafts().length, 0); assert.equal(f.store.db.prepare("SELECT count(*) AS n FROM sessions").get()!.n, 0);
});
test("聊天保存失败仍无草稿，恢复存储后重试复用原会话", async t => {
  const f = fixture(t), chat = controller(f); f.service.saveFailures = "always";
  const first = await chat.handle("安排 M01 2030-01-01 17:00"); assert.equal(first.run?.runStatus, "failed"); assert.equal(f.store.drafts().length, 0);
  f.service.saveFailures = 0; const retried = await chat.handle("重试保存");
  assert.equal(retried.run?.sessionId, first.run?.sessionId); assert.equal(retried.run?.items[0].status, "saved"); assert.equal(f.store.drafts().length, 1);
});
test("无会话的恢复与确认输入返回提示，不使聊天进程崩溃", async t => {
  const f = fixture(t), chat = controller(f);
  for (const text of ["查看结果", "再处理一次相同请求", "同意", "重试保存", "补充 M06，标题=教程"]) assert.ok((await chat.handle(text)).errorCode?.startsWith("CHAT_NO_"));
  assert.match((await chat.handle("查看待处理素材")).text, /M06/);
});
test("聊天同意后时段再次被占用，复检产生新建议而不沿用旧批准保存", async t => {
  const f = fixture(t), chat = controller(f), first = await chat.handle(schedule);
  writeFileSync(resolve(f.dataDir, "schedules.json"), JSON.stringify([{ channel: "douyin", at: at(18), materialId: "BUSY18" }, { channel: "douyin", at: at(19), materialId: "BUSY19" }]));
  const next = await chat.handle("同意改期"); assert.equal(next.run?.items[0].status, "needs_confirmation");
  assert.equal(next.run?.items[0].proposal?.at, at(20)); assert.notEqual(next.run?.items[0].proposal?.id, first.run?.items[0].proposal?.id);
  assert.equal(f.store.drafts().length, 0); assert.deepEqual(next.run?.items[0].pendingConfirmations, ["time_change"]);
});
test("开始另一个未完整请求后，不能把泛化同意套用到上一个素材", async t => {
  const f = fixture(t), chat = controller(f), first = await chat.handle(schedule);
  await chat.handle("安排 M05");
  await chat.handle("查看结果");
  assert.match((await chat.handle("同意")).text, /尚未完整/);
  assert.equal(f.service.show(first.run!.sessionId).confirmations.length, 0);
  const second = await chat.handle("2030-01-01 17:00");
  assert.equal(second.run?.items[0].materialId, "M05"); assert.equal(second.run?.items[0].status, "saved");
  assert.equal(f.service.show(first.run!.sessionId).items[0].saveStatus, "not_saved");
});
test("模糊输入澄清后仍保留当前建议，上下文中的同意可以继续保存", async t => {
  const f = fixture(t), chat = controller(f), first = await chat.handle(schedule);
  const token = chat.businessView().confirmation!.id;
  const unclear = await chat.handle("统一");
  assert.match(unclear.text, /19:00/); assert.match(unclear.text, /同意/);
  assert.equal(chat.businessView().confirmation!.id, token); assert.equal(f.store.drafts().length, 0);
  const accepted = await chat.handle("同意"); assert.equal(accepted.run?.items[0].draft?.at, at(19));
  assert.equal(f.service.show(first.run!.sessionId).confirmations.length, 1);
});
test("确认可用于单一待确认事项，不能笼统批准时间与风险两项", async t => {
  const f = fixture(t), chat = controller(f);
  await chat.handle("安排 M03 2030-01-01 18:00");
  assert.match((await chat.handle("确认")).text, /分别输入/); assert.equal(f.store.drafts().length, 0);
});
