import { BusinessError, type Proposal, type ItemInput } from "../types.ts";
import { normalizeAt } from "../domain/schedule-policy.ts";

export type ChatIntent =
  | { kind: "help" | "exit" | "pending" | "show" | "json" | "why" | "repeat" | "retry" | "cancel_input" | "publish" }
  | { kind: "material"; materialId: string; channel?: string; at?: string }
  | { kind: "use"; sessionId: string; materialId?: string; channel?: string }
  | { kind: "confirm"; decision: "accept" | "reject"; kinds?: Proposal["kinds"]; at?: string }
  | { kind: "supplement"; materialId?: string; fields: Record<string, string> }
  | { kind: "schedule"; item: ItemInput };

function error(code: string, message: string): never { throw new BusinessError(code, message); }
const ids = (text: string) => [...new Set((text.match(/\bM\d+\b/gi) ?? []).map(s => s.toUpperCase()))];
const channelNames: Record<string, string> = { 抖音: "douyin", 小红书: "xiaohongshu", 视频号: "wechat_channels" };

function dateInShanghai(now: Date, offset: number) {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date(now.getTime() + offset * 86400_000));
  const part = (name: string) => parts.find(p => p.type === name)!.value;
  return `${part("year")}-${part("month")}-${part("day")}`;
}
export function resolveChatDate(raw: string, now: Date): string {
  const absolute = raw.match(/^(\d{4})[-年](\d{1,2})[-月](\d{1,2})日?$/);
  if (absolute) {
    const date = `${absolute[1]}-${absolute[2].padStart(2, "0")}-${absolute[3].padStart(2, "0")}`;
    const value = new Date(date + "T00:00:00Z");
    if (!Number.isFinite(value.getTime()) || value.toISOString().slice(0, 10) !== date) error("INVALID_DATE", "日期无效，请提供有效的年月日。");
    return date;
  }
  if (/^(今天|明天|后天|今晚|明晚)$/.test(raw)) return dateInShanghai(now, /明/.test(raw) ? 1 : raw === "后天" ? 2 : 0);
  const week = raw.match(/^(本周|这周|下周|下下周)([一二三四五六日天])$/);
  if (week) {
    const weekday = (new Date(dateInShanghai(now, 0) + "T00:00:00Z").getUTCDay() + 6) % 7;
    const wanted = "一二三四五六日".indexOf(week[2] === "天" ? "日" : week[2]);
    return dateInShanghai(now, (week[1] === "下周" ? 7 : week[1] === "下下周" ? 14 : 0) + wanted - weekday);
  }
  return error("CHAT_INFORMATION_REQUIRED", "请明确日期，例如 2030-01-01、明天或下周一；不会猜测未支持的日期表达。");
}
function splitFields(text: string) {
  const result: string[] = []; let start = 0, close = "";
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (close) { if (c === close) close = ""; }
    else if ('"\'“‘'.includes(c)) close = ({ '"': '"', "'": "'", "“": "”", "‘": "’" } as Record<string, string>)[c];
    else if (",，;；".includes(c)) { result.push(text.slice(start, i).trim()); start = i + 1; }
  }
  if (close) error("INVALID_CHAT_INPUT", "补充字段的引号未闭合，请使用 标题=教程，授权=已授权。");
  result.push(text.slice(start).trim()); return result.filter(Boolean);
}

/** Deliberately bounded language adapter. It never infers consent with a model. */
export function parseChatIntent(raw: string, now = new Date()): ChatIntent {
  const text = raw.trim().replace(/[。！!]+$/, "");
  if (["帮助", "怎么用", "/help", "help"].includes(text)) return { kind: "help" };
  if (["退出", "结束聊天", "/exit", "/quit", "exit"].includes(text)) return { kind: "exit" };
  if (["取消输入", "取消", "/cancel"].includes(text)) return { kind: "cancel_input" };
  if (["发布", "立即发布", "现在发布", "帮我发布"].includes(text)) return { kind: "publish" };
  const material = text.match(/^(?:(?:查看|查询|继续|选择|恢复)(?:待处理(?:素材|清单)?|素材|任务|排期|状态|草稿)?\s*)?(M\d+)(?:\s*(?:的)?(?:状态|任务|排期|草稿))?$/i);
  if (material) return { kind: "material", materialId: material[1].toUpperCase() };
  const task = text.match(/^(?:查看|查询|继续|选择|恢复)(?:素材|任务)?\s*(M\d+)\s+(.+)$/i);
  if (task) {
    try {
      const schedule = parseChatIntent(`安排 ${task[1]} ${task[2]}`, now);
      if (schedule.kind === "schedule" && schedule.item.requirement.kind === "fixed") return { kind: "material", materialId: schedule.item.materialId, at: schedule.item.requirement.at, ...(/渠道|channel|抖音|douyin|小红书|xiaohongshu|视频号|wechat_channels/i.test(task[2]) ? { channel: schedule.item.channel } : {}) };
    } catch { error("CHAT_MATERIAL_TASK_AMBIGUOUS", "请同时说明已有任务的原定日期、整点时间和渠道，例如：查看 M06 2030-01-01 17:00 渠道 douyin。"); }
  }
  if (/^(?:请)?(?:查看|查询|列出)?待处理(?:素材|清单)?$/.test(text) || text === "/pending") return { kind: "pending" };
  if (["查看结果", "查看状态", "查看当前状态", "查看当前建议", "查看草稿", "/show", "/state"].includes(text)) return { kind: "show" };
  if (["查看详细结果", "/json"].includes(text)) return { kind: "json" };
  if (/^(?:为什么|解释|说明)(?:.*)$/.test(text) || text === "/why") return { kind: "why" };
  if (["重跑", "再处理一次", "再处理一次相同请求", "重新处理相同请求", "重复提交", "/again"].includes(text)) return { kind: "repeat" };
  if (["重试", "重试保存", "/retry"].includes(text)) return { kind: "retry" };
  const use = text.match(/^(?:\/use|恢复会话|切换会话)\s+(s_[a-f0-9]+)(?:\s+(M\d+))?(?:\s+([a-zA-Z0-9_-]+))?$/i);
  if (use) return { kind: "use", sessionId: use[1], materialId: use[2]?.toUpperCase(), channel: use[3] };
  if (["同意", "确认", "我同意", "同意当前建议", "确认当前建议", "/confirm"].includes(text)) return { kind: "confirm", decision: "accept" };
  if (["同意改期", "同意更改时间", "/confirm time_change"].includes(text)) return { kind: "confirm", decision: "accept", kinds: ["time_change"] };
  if (["接受风险", "接受当前风险", "确认风险", "同意风险确认", "/confirm risk_ack"].includes(text)) return { kind: "confirm", decision: "accept", kinds: ["risk_ack"] };
  if (["同意改期并接受风险", "/confirm all"].includes(text)) return { kind: "confirm", decision: "accept", kinds: ["time_change", "risk_ack"] };
  if (["拒绝", "不同意", "拒绝当前建议", "/reject"].includes(text)) return { kind: "confirm", decision: "reject" };
  const acceptTime = text.match(/^同意(?:这次)?改到\s*(\d{1,2})(?::(\d{2})|点(?:整)?)$/);
  if (acceptTime) {
    const h = Number(acceptTime[1]), m = Number(acceptTime[2] ?? 0);
    if (h > 23 || m !== 0) error("INVALID_CHAT_INPUT", "确认时间须为 00:00–23:00 的整点。");
    return { kind: "confirm", decision: "accept", kinds: ["time_change"], at: `${String(h).padStart(2, "0")}:00` };
  }
  const supplement = text.match(/^补充\s*(M\d+)?\s*[，,:：]?\s*(.+)$/i);
  if (supplement) {
    const fields: Record<string, string> = {}, fieldNames: Record<string, string> = { 标题: "title", 内容: "text", 授权: "rights", 授权状态: "rights", title: "title", text: "text", rights: "rights" };
    for (const entry of splitFields(supplement[2])) {
      const m = entry.match(/^(标题|内容|授权状态|授权|title|text|rights)\s*(?:=|[:：]|为|是)\s*(.+)$/);
      if (!m) error("INVALID_CHAT_INPUT", "补充格式：补充 M06，标题=教程，授权=已授权；允许标题、内容和授权字段。");
      const key = fieldNames[m[1]]; let value = m[2].trim();
      const pairs: Record<string, string> = { '"': '"', "'": "'", "“": "”", "‘": "’" };
      if (pairs[value[0]] === value.at(-1)) value = value.slice(1, -1);
      if (!value || fields[key] !== undefined) error("INVALID_CHAT_INPUT", "字段不能为空或重复，未执行任何补充。");
      if (key === "rights") {
        const rights: Record<string, string> = { granted: "granted", 已授权: "granted", 已获得授权: "granted", unknown: "unknown", 未确认: "unknown", 不知道: "unknown", denied: "denied", 未授权: "denied", 拒绝授权: "denied" };
        if (!rights[value]) error("INVALID_CHAT_INPUT", "授权须明确为 已授权、未确认 或 未授权，不能猜测。");
        value = rights[value];
      }
      fields[key] = value;
    }
    return { kind: "supplement", materialId: supplement[1]?.toUpperCase(), fields };
  }
  if (!/^(?:请)?(?:帮我)?\s*(?:(?:将|把)?\s*M\d+|安排|排期)/i.test(text) || !/(?:安排|排期|排到|排在)/.test(text)) error("UNKNOWN_CHAT_INPUT", "可以说：将 M01 安排在 2030-01-01 18:00，渠道 douyin。输入“帮助”查看用法。");
  if (/不要|不保存|不安排|不必|不用|无需|跳过|取消|能否|是否|能不能|如果|假设|查询|查看|发布|[?？]/.test(text)) error("AMBIGUOUS_CHAT_INPUT", "这句话含条件、查询或限制，尚未执行排期。请明确要处理的素材、日期和时间；系统只保存草稿。");
  if (/不晚于|不早于|最晚|最早|大约|尽量|窗口|范围|任选|(?:点|时|:\d{2})\s*(?:前|后|左右|以内)/.test(text)) error("AMBIGUOUS_CHAT_INPUT", "不会将截止时间或弹性范围改为固定时间，请明确固定整点，或使用 JSON 窗口入口。");
  if (/UTC|GMT|时区(?!\s*(?:Asia\/Shanghai|上海|北京))/i.test(text)) error("AMBIGUOUS_CHAT_INPUT", "聊天默认上海时间；其他时区请使用带 Z 或 +08:00 的完整 ISO 时间。");
  if (/[点时]\s*(?:半|一刻|三刻|\d)/.test(text)) error("INVALID_TIME", "不能将半点或分钟要求改为整点，请明确一个整点，例如 18:00。");
  if (/\d{1,2}(?:点|时|:\d{2})?\s*(?:到|至|~|～|-)\s*\d{1,2}(?:点|时|:\d{2})/.test(text)) error("AMBIGUOUS_CHAT_INPUT", "聊天入口不把时间范围改为固定时间；窗口排期请使用 JSON 入口。");
  const materials = ids(text);
  if (materials.length > 1) error("AMBIGUOUS_CHAT_INPUT", "聊天每条排期处理一个素材；请分别发送，批量可使用 run --input。");
  if (!materials.length) error("CHAT_INFORMATION_REQUIRED", "请补充素材 ID，例如 M01。");
  const channelMatch = text.match(/(?:渠道(?:为|是)?|channel)\s*[:：=]?\s*([a-zA-Z0-9_-]+|抖音|小红书|视频号)/i);
  if (/渠道|channel/i.test(text) && !channelMatch) error("INVALID_CHAT_INPUT", "请明确渠道，例如 渠道 douyin。");
  const channel = channelMatch ? channelNames[channelMatch[1]] ?? channelMatch[1] : "douyin";
  const iso = [...text.matchAll(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:Z|\+08:00)/g)];
  let at: string;
  if (iso.length) {
    if (iso.length !== 1 || /\d{1,2}(?::\d{2}|点|时)/.test(text.replace(iso[0][0], ""))) error("AMBIGUOUS_CHAT_INPUT", "请只指定一个固定发布时间。");
    at = normalizeAt(iso[0][0]);
  } else {
    const dates = [...text.matchAll(/(\d{4})[-年](\d{1,2})[-月](\d{1,2})日?/g)];
    const relative = [...text.matchAll(/(?:下下周|下周|本周|这周)[一二三四五六日天]|今天|明天|后天|今晚|明晚/g)];
    if (dates.length + relative.length > 1) error("AMBIGUOUS_CHAT_INPUT", "请只指定一个日期，不会擅自选择或改变硬性要求。");
    if (!dates.length && !relative.length) error("CHAT_INFORMATION_REQUIRED", "请补充日期，例如 2030-01-01，或明确说今天、明天。");
    const date = resolveChatDate(dates.length ? dates[0][0] : relative[0][0], now);
    const times = [...text.matchAll(/(\d{1,2}):(\d{2})(?::(\d{2}))?|(\d{1,2})\s*(?:点|时)(?:整)?/g)];
    if (times.length > 1) error("AMBIGUOUS_CHAT_INPUT", "请只指定一个固定时间，需要窗口排期请使用 JSON 入口。");
    if (!times.length) error("CHAT_INFORMATION_REQUIRED", "请补充整点时间，例如 18:00 或下午6点。");
    const time = times[0]; let hour = Number(time[1] ?? time[4]);
    if (Number(time[2] ?? 0) !== 0 || Number(time[3] ?? 0) !== 0 || hour > 23) error("INVALID_TIME", "当前时段为整点容量，请明确 00:00–23:00 的整点。");
    const pm = /下午|晚上|傍晚|中午|明晚|今晚/.test(text), am = /上午|早上|凌晨/.test(text);
    if (pm && am || pm && hour === 0 || am && hour > 12) error("AMBIGUOUS_CHAT_INPUT", "上下午表述不明确，请使用 24 小时制，例如 18:00。");
    if (hour === 12 && /晚上|明晚|今晚|傍晚/.test(text)) error("AMBIGUOUS_CHAT_INPUT", "夜间12点存在跨日歧义，请明确完整日期和 00:00，不会按中午处理。");
    if (pm && hour < 12) hour += 12;
    if (am && hour === 12) hour = 0;
    at = normalizeAt(`${date}T${String(hour).padStart(2, "0")}:00:00+08:00`);
  }
  return { kind: "schedule", item: { materialId: materials[0], channel, requirement: { kind: "fixed", at } } };
}
