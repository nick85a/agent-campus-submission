import { parseArgs } from "node:util";
import { Store } from "../store.ts";
import { SchedulerService } from "../service.ts";
import { BusinessChatApi } from "./chat-service.ts";
import { createBusinessChatServer } from "./server.ts";

const { values } = parseArgs({ options: { port: { type: "string", default: "8787" }, db: { type: "string", default: ".runtime/business-chat.sqlite" }, mode: { type: "string", default: "live" }, "data-dir": { type: "string", default: "data" } } });
const port = Number(values.port), mode = values.mode;
if (!Number.isInteger(port) || port < 0 || port > 65535 || mode !== "live" && mode !== "mock") throw new Error("启动参数无效");
const store = new Store(values.db!, values["data-dir"]), service = new SchedulerService(store, process.env.SCHEDULER_ACTOR ?? "local-user");
const server = createBusinessChatServer(new BusinessChatApi(service, { mode }));
server.listen(port, "127.0.0.1", () => { const address = server.address(); process.stdout.write(`业务聊天服务：http://127.0.0.1:${typeof address === "object" && address ? address.port : port}/api/chat\n`); });
server.on("error", () => { process.stderr.write("业务聊天服务启动失败，请检查端口和配置。\n"); store.close(); process.exitCode = 1; });
for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => server.close(() => store.close()));
