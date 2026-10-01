import { useEffect, useState } from "react";
import { CircleHelp, RefreshCw } from "lucide-react";
import { api } from "../lib/ipc.ts";
import { useApp } from "../shell/AppContext.tsx";
import { Button } from "../ui/Button.tsx";
import { useToast } from "../ui/Toasts.tsx";
import { PENDING_HELP } from "./help-links.ts";
export function AskHelp({topic,error,onNavigate}:{topic:string;error?:string;onNavigate?:()=>void}) {
  const {navigate}=useApp(); const toast=useToast(); const [busy,setBusy]=useState(false);
  return <Button size="sm" variant="ghost" icon={CircleHelp} disabled={busy} onClick={()=>{
    setBusy(true);
    void api.aiHelpPrompt(topic,error).then(question=>{
      sessionStorage.setItem(PENDING_HELP,question);
      onNavigate?.();
      navigate({page:"ai",context:"help",question});
    }).catch(toast.error).finally(()=>setBusy(false));
  }}>Ask for help</Button>;
}
export function HelpContext() {
  const [snapshot,setSnapshot]=useState<unknown>(); const [error,setError]=useState(""); const [busy,setBusy]=useState(false);
  const refresh=async()=>{setBusy(true);setError("");try {setSnapshot(await api.aiHelpContext());}catch{setError("App status could not be collected. Retry before sending.");}finally{setBusy(false);}};
  useEffect(()=>{void refresh();},[]);
  return <details className="chat-help-context"><summary>What Concord help shares</summary>
    <p>This version’s guide, setup status, counts and error categories. No keys, file paths, source names, raw logs or recordings are added. Your message is also sent to your selected chat provider.</p>
    <p>A fresh snapshot is collected when you send. The preview below stays on this computer until then.</p>
    <Button size="sm" icon={RefreshCw} disabled={busy} onClick={()=>void refresh()}>Refresh preview</Button>
    {error && <p role="alert">{error}</p>}
    <pre aria-label="App status preview">{snapshot ? JSON.stringify(snapshot,null,2) : "Checking app status…"}</pre>
  </details>;
}
