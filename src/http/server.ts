import { createServer, type IncomingMessage } from "node:http";
import { BusinessChatApi, ApiError } from "./chat-service.ts";

async function body(req: IncomingMessage) {
  if (!String(req.headers["content-type"] ?? "").toLowerCase().startsWith("application/json")) throw new ApiError(415, "请使用 JSON 发送消息。");
  return new Promise<unknown>((resolve, reject) => {
    const chunks: Buffer[] = []; let size = 0, settled = false;
    const stop = (error?: ApiError) => {
      if (settled) return; settled = true;
      req.off("data", data); req.off("end", end); req.off("aborted", aborted);
      if (error) { req.resume(); reject(error); return; }
      try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8"))); }
      catch { reject(new ApiError(400, "消息格式无效。")); }
    };
    const data = (chunk: Buffer) => { size += chunk.length; if (size > 16384) stop(new ApiError(413, "请求内容过长。")); else chunks.push(chunk); };
    const end = () => stop(), aborted = () => stop(new ApiError(400, "请求已中断。"));
    req.on("data", data); req.once("end", end); req.once("aborted", aborted); req.once("error", aborted);
  });
}
export function createBusinessChatServer(api: BusinessChatApi) {
  const server = createServer(async (req, res) => {
    res.setHeader("Content-Type", "application/json; charset=utf-8"); res.setHeader("Cache-Control", "no-store");
    try {
      if (req.method === "GET" && req.url === "/health") { res.end(JSON.stringify({ status: "ok" })); return; }
      if (req.method !== "POST" || req.url !== "/api/chat") throw new ApiError(404, "接口不存在。");
      const response = await api.chat(await body(req));
      if (!res.destroyed) res.end(JSON.stringify(response));
    } catch (error) {
      if (res.destroyed) return;
      res.statusCode = error instanceof ApiError ? error.status : 500;
      res.end(JSON.stringify({ message: error instanceof ApiError ? error.message : "服务暂时无法处理请求，请稍后重试。" }));
    }
  });
  server.once("close", () => api.dispose());
  return server;
}
