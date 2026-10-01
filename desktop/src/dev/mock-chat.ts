// Synthetic chat data for visual review only; this module is loaded exclusively by ?mock.
import { setupHandlers } from "./mock-setup.ts";
const sources = [
  {
    kind: "recording",
    id: "rec-01",
    title: "Harbour conversation",
    channel: "Tuesday Study",
    date: "2025-09-02",
    text: "The community agreed to meet again next week and review the proposal together.",
    start: 65,
    end: 80,
    score: 1,
  },
  {
    kind: "document",
    id: "doc-1",
    title: "Meeting notes",
    channel: "",
    date: "",
    text: "We will review the proposal together next Tuesday.",
    start: null,
    end: null,
    score: 1,
  },
];
const conversation = {
  id: "chat-demo",
  title: "Planning our next conversation",
  pinned: 1,
  updated_at: "2026-10-01",
  messages: 2,
};
const messages = [
  {
    id: "m1",
    role: "user",
    content: "What did we agree to do next?",
    context_kind: "archive",
    context_media_id: "",
    context_status: "",
    model: "",
    sources: [],
    starred: 0,
    error: 0,
    created_at: "",
  },
  {
    id: "m2",
    role: "assistant",
    content:
      "The next step is to **review the proposal together next Tuesday**. The meeting notes confirm the date [2].\n\nYou could collect your questions beforehand and bring them to that conversation.",
    context_kind: "archive",
    context_media_id: "",
    context_status: "",
    model: "demo-chat",
    sources,
    starred: 0,
    error: 0,
    created_at: "",
  },
];
export const chatHandlers: Record<string, (args: any) => unknown> = {
  ai_config: () => {
    const c = setupHandlers.ai_config({}) as any;
    if (new URLSearchParams(location.search).has("chat-preview"))
      c.chat = {
        ...c.chat,
        enabled: true,
        kind: "local",
        model: "demo-chat",
        local: true,
      };
    return c;
  },
  ai_conversations: () => [conversation],
  ai_read_chat: () => ({ conversation, messages }),
  ai_help_context: () => ({
    version: "visual preview",
    speech: {
      installed: true,
      ready: true,
      selectedDevice: "auto",
      gpuDetected: true,
    },
    pipeline: { running: false },
    recentErrors: [],
  }),
  ai_help_prompt: ({ topic }) =>
    `Help me with ${topic}. What should I check next?`,
};
