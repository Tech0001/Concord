import { useEffect, useRef, useState } from "react";
import { api } from "../lib/ipc.ts";
import { Button } from "../ui/Button.tsx";
import { Dialog } from "../ui/Dialog.tsx";
import { Select } from "../ui/Select.tsx";
import { useToast } from "../ui/Toasts.tsx";
import type { ChatGPTStatus } from "./types.ts";

export function ChatGPTUsage() {
  const toast = useToast();
  return (
    <span className="chatgpt-usage">
      Using ChatGPT plan ·{" "}
      <button
        type="button"
        className="text-link"
        onClick={() =>
          void api
            .openExternal("https://chatgpt.com/settings/usage")
            .catch(toast.error)
        }
      >
        Manage usage
      </button>
    </span>
  );
}
export function ChatGPTSettings({
  accountId,
  onAccount,
}: {
  accountId: string;
  onAccount: (id: string, ready: boolean) => void;
}) {
  const [state, setState] = useState<ChatGPTStatus>();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const consumed = useRef("");
  const awaitedAttempt = useRef("");
  const accountCallback = useRef(onAccount);
  accountCallback.current = onAccount;
  const toast = useToast();
  const update = (value: ChatGPTStatus) => {
    setState(value);
    setError("");
    const p = value.pending;
    if (p.running) awaitedAttempt.current = p.attemptId;
    if (
      !p.running &&
      p.attemptId &&
      p.attemptId === awaitedAttempt.current &&
      consumed.current !== p.attemptId
    ) {
      consumed.current = p.attemptId;
      const a = value.accounts.find((a) => a.id === p.accountId);
      if (a) accountCallback.current(a.id, a.connected && a.planEnabled);
    }
  };
  const updateRef = useRef(update);
  updateRef.current = update;
  const reload = async () => {
    const value = await api.chatgptStatus();
    updateRef.current(value);
    return value;
  };
  const begin = async (id: string | null, consent = false) => {
    await api.chatgptStart(id, consent);
    const value = await api.chatgptStatus();
    awaitedAttempt.current = value.pending.attemptId;
    updateRef.current(value);
  };
  useEffect(() => {
    let alive = true,
      timer = 0;
    const poll = async () => {
      try {
        const value = await api.chatgptStatus();
        if (!alive) return;
        updateRef.current(value);
        timer = window.setTimeout(poll, value.pending.running ? 500 : 2000);
      } catch (e) {
        if (alive) {
          setError(String(e));
          timer = window.setTimeout(poll, 3000);
        }
      }
    };
    void poll();
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, []);
  const account = state?.accounts.find((a) => a.id === accountId);
  const run = async (work: () => Promise<unknown>) => {
    setBusy(true);
    setMessage("");
    try {
      await work();
      await reload();
    } catch (e) {
      toast.error(e);
    } finally {
      setBusy(false);
    }
  };
  const dismiss = () => {
    if (account) void run(() => api.chatgptAcknowledge(account.id));
  };
  return (
    <section className="chatgpt-settings" aria-label="ChatGPT connection">
      <p>
        Use your ChatGPT plan for chat, summaries and suggested tags. Selected
        excerpts and your messages go to OpenAI. Embeddings keep their separate
        provider.
      </p>
      {!!state?.accounts.length && (
        <label className="field">
          <span>ChatGPT account</span>
          <Select
            label="ChatGPT account"
            value={accountId}
            onChange={(id) => {
              const a = state.accounts.find((a) => a.id === id);
              onAccount(id, !!a?.connected && !!a?.planEnabled);
            }}
            options={[
              { value: "", label: "Choose an account" },
              ...state.accounts.map((a) => ({
                value: a.id,
                label: `${a.label}${a.connected ? "" : " · signed out"}`,
              })),
            ]}
          />
        </label>
      )}
      {account && (
        <p role="status">
          {account.connected
            ? account.planEnabled
              ? "Connected · ChatGPT plan usage enabled"
              : "Signed in · ChatGPT plan usage is disabled"
            : "Signed out · continue with ChatGPT to reconnect"}
        </p>
      )}
      <div className="ai-actions">
        {state?.pending.running ? (
          <Button
            disabled={busy}
            onClick={() => void run(() => api.chatgptCancel())}
          >
            Cancel sign-in
          </Button>
        ) : (
          <>
            {
              <Button
                className="chatgpt-signin"
                disabled={busy}
                onClick={() =>
                  void run(() =>
                    begin(
                      account?.id ?? null,
                      !!account?.connected && !account.planEnabled,
                    ),
                  )
                }
              >
                Continue with ChatGPT
              </Button>
            }
            {account && (
              <Button
                disabled={busy}
                onClick={() => void run(() => begin(null))}
              >
                Add another ChatGPT account
              </Button>
            )}
            {account?.connected && (
              <Button
                disabled={busy}
                onClick={() =>
                  void run(async () => {
                    setMessage(await api.chatgptSignOut(account.id));
                    onAccount(account.id, false);
                  })
                }
              >
                Sign out of ChatGPT
              </Button>
            )}
          </>
        )}
      </div>
      {state?.pending.message && (
        <p className="muted" role="status">
          {state.pending.message}
        </p>
      )}
      {(error || state?.pending.error) && (
        <p role="alert" className="field-error">
          {error || state?.pending.error}
        </p>
      )}
      {message && <p role="status">{message}</p>}
      {account?.connected && account.planEnabled && <ChatGPTUsage />}
      <small className="muted">
        Concord stores its own protected connection on this computer. Signing
        out keeps the account registration for later sign-in.
      </small>
      <Dialog
        open={
          !!account?.connected && account.planEnabled && !account.welcomeSeen
        }
        onOpenChange={(open) => {
          if (!open) dismiss();
        }}
        title="You're using your ChatGPT plan"
        footer={<Button onClick={dismiss}>Got it</Button>}
      >
        <p>
          When you enable this chat provider, eligible requests use your ChatGPT
          plan or credits. Manage Concord's allowance in ChatGPT settings.
        </p>
        <ChatGPTUsage />
      </Dialog>
    </section>
  );
}
