import test from "node:test";
import assert from "node:assert/strict";
import { readModelSettings } from "../src/model.ts";

test("模型参数保留默认值，并支持低成本非思考配置", () => {
  assert.deepEqual(readModelSettings({}), { maxTokens: 2048, contextWindow: 32000, disableThinking: false });
  assert.deepEqual(readModelSettings({ MODEL_MAX_TOKENS: "1024", MODEL_CONTEXT_WINDOW: "262144", MODEL_DISABLE_THINKING: "true" }), { maxTokens: 1024, contextWindow: 262144, disableThinking: true });
});
test("无效 Token 或思考参数在发起模型请求前被拒绝", () => {
  for (const value of ["0", "-1", "NaN", "1.5", "Infinity", "9007199254740992"]) assert.throws(() => readModelSettings({ MODEL_MAX_TOKENS: value }), { code: "MODEL_CONFIGURATION_ERROR" });
  assert.throws(() => readModelSettings({ MODEL_MAX_TOKENS: "2048", MODEL_CONTEXT_WINDOW: "1024" }), { code: "MODEL_CONFIGURATION_ERROR" });
  assert.throws(() => readModelSettings({ MODEL_DISABLE_THINKING: "yes" }), { code: "MODEL_CONFIGURATION_ERROR" });
});
