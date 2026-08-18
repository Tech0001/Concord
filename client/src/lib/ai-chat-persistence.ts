/** Small subset of the Web Storage API used here, kept structural so the
 * persistence rules are easy to exercise without a browser. */
export interface ChatStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

const ACTIVE_CONVERSATION_KEY = "concord-ai-active-conversation-v1";
const DRAFTS_KEY = "concord-ai-drafts-v1";
const NEW_CHAT_DRAFT_KEY = "__new_chat__";

type DraftMap = Record<string, string>;

function draftKey(conversationId: string): string {
  return conversationId || NEW_CHAT_DRAFT_KEY;
}

function readDrafts(storage?: ChatStorage | null): DraftMap {
  if (!storage) return {};
  try {
    const parsed = JSON.parse(storage.getItem(DRAFTS_KEY) || "{}");
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return Object.fromEntries(
      Object.entries(parsed).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
    );
  } catch {
    return {};
  }
}

export function loadActiveConversationId(storage?: ChatStorage | null): string {
  if (!storage) return "";
  try {
    return storage.getItem(ACTIVE_CONVERSATION_KEY)?.trim() || "";
  } catch {
    return "";
  }
}

export function saveActiveConversationId(
  storage: ChatStorage | null | undefined,
  conversationId: string,
): void {
  if (!storage) return;
  try {
    if (conversationId) storage.setItem(ACTIVE_CONVERSATION_KEY, conversationId);
    else storage.removeItem(ACTIVE_CONVERSATION_KEY);
  } catch {
    // Storage can be unavailable or full. Chat remains usable in memory.
  }
}

export function loadChatDraft(
  storage: ChatStorage | null | undefined,
  conversationId: string,
): string {
  return readDrafts(storage)[draftKey(conversationId)] || "";
}

export function saveChatDraft(
  storage: ChatStorage | null | undefined,
  conversationId: string,
  draft: string,
): void {
  if (!storage) return;
  try {
    const drafts = readDrafts(storage);
    const key = draftKey(conversationId);
    if (draft) drafts[key] = draft;
    else delete drafts[key];

    if (Object.keys(drafts).length === 0) storage.removeItem(DRAFTS_KEY);
    else storage.setItem(DRAFTS_KEY, JSON.stringify(drafts));
  } catch {
    // Best-effort only; never let draft persistence block the composer.
  }
}

export function deleteChatDraft(
  storage: ChatStorage | null | undefined,
  conversationId: string,
): void {
  saveChatDraft(storage, conversationId, "");
}
