import assert from "node:assert/strict";
import test from "node:test";
import {
  deleteChatDraft,
  loadActiveConversationId,
  loadChatDraft,
  saveActiveConversationId,
  saveChatDraft,
  type ChatStorage,
} from "./ai-chat-persistence";

class MemoryStorage implements ChatStorage {
  private values = new Map<string, string>();
  getItem(key: string): string | null { return this.values.get(key) ?? null; }
  setItem(key: string, value: string): void { this.values.set(key, value); }
  removeItem(key: string): void { this.values.delete(key); }
}

test("restores and clears the active conversation", () => {
  const storage = new MemoryStorage();
  saveActiveConversationId(storage, "conversation-1");
  assert.equal(loadActiveConversationId(storage), "conversation-1");
  saveActiveConversationId(storage, "");
  assert.equal(loadActiveConversationId(storage), "");
});

test("keeps independent drafts for new and existing conversations", () => {
  const storage = new MemoryStorage();
  saveChatDraft(storage, "", "new question");
  saveChatDraft(storage, "conversation-1", "follow-up one");
  saveChatDraft(storage, "conversation-2", "follow-up two");

  assert.equal(loadChatDraft(storage, ""), "new question");
  assert.equal(loadChatDraft(storage, "conversation-1"), "follow-up one");
  assert.equal(loadChatDraft(storage, "conversation-2"), "follow-up two");
});

test("deleting one draft leaves the others intact", () => {
  const storage = new MemoryStorage();
  saveChatDraft(storage, "conversation-1", "keep editing");
  saveChatDraft(storage, "conversation-2", "keep this");
  deleteChatDraft(storage, "conversation-1");

  assert.equal(loadChatDraft(storage, "conversation-1"), "");
  assert.equal(loadChatDraft(storage, "conversation-2"), "keep this");
});

test("malformed stored data degrades to an empty state", () => {
  const storage = new MemoryStorage();
  storage.setItem("concord-ai-drafts-v1", "not json");
  assert.equal(loadChatDraft(storage, "conversation-1"), "");
});
