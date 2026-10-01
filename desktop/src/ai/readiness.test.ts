import { test } from "node:test";
import assert from "node:assert/strict";
import { chatReady, type Provider } from "./types.ts";
test("ChatGPT needs an enabled model and a connected account, independent of embedding keys", () => {
  const p: Provider = { kind: "chatgpt", enabled: true, model: "account-model", baseUrl: "https://api.openai.com/v1", hasKey: false, local: false };
  assert.equal(chatReady(p), false);
  assert.equal(chatReady({ ...p, connected: true }), true);
  assert.equal(chatReady({ ...p, connected: true, enabled: false }), false);
  assert.equal(chatReady({ ...p, connected: true, model: "" }), false);
  assert.equal(chatReady({ ...p, kind: "local", local: true }), true);
  assert.equal(chatReady({ ...p, kind: "openrouter", hasKey: false }), false);
});
