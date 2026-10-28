import { SchedulerService } from "../service.ts";
import { BusinessError } from "../types.ts";
import type { ChatSnapshot } from "./controller.ts";

/** The selected business task and native Pi session must be restored together. */
export class TerminalCheckpoint {
  readonly context?: ChatSnapshot;
  private version: number;
  constructor(private readonly service: SchedulerService, private readonly mode: string) {
    service.store.db.exec("CREATE TABLE IF NOT EXISTS terminal_chat_context(owner TEXT NOT NULL,mode TEXT NOT NULL,context TEXT NOT NULL,version INTEGER NOT NULL,PRIMARY KEY(owner,mode))");
    const row = service.store.db.prepare("SELECT context,version FROM terminal_chat_context WHERE owner=? AND mode=?").get(service.actor, mode);
    this.context = row ? JSON.parse(String(row.context)) as ChatSnapshot : undefined;
    this.version = Number(row?.version ?? 0);
  }
  save(context: ChatSnapshot) {
    const result = this.service.store.db.prepare("INSERT INTO terminal_chat_context VALUES(?,?,?,1) ON CONFLICT(owner,mode) DO UPDATE SET context=excluded.context,version=terminal_chat_context.version+1 WHERE terminal_chat_context.version=?")
      .run(this.service.actor, this.mode, JSON.stringify(context), this.version);
    if (result.changes !== 1) throw new BusinessError("CHAT_SESSION_CHANGED", "另一个终端已更新这段对话，请重启聊天恢复最新进度。业务处理结果已保留。");
    this.version++;
  }
}
