import { useEffect, useState } from "react";
import { Play } from "lucide-react";
import { api } from "../lib/ipc.ts";
import { humanDuration } from "../lib/format.ts";
import { speakerColor, SPEAKER_COLORS } from "../lib/speakers.ts";
import type { Speaker } from "../lib/types.ts";
import { Button } from "../ui/Button.tsx";
import { Dialog } from "../ui/Dialog.tsx";
import { useToast } from "../ui/Toasts.tsx";
import { ColorPicker } from "../speakers/ColorPicker.tsx";
import type { Voice } from "./voices.ts";
import "../speakers/speakers.css";

export function NameVoiceDialog({ mediaId, voice, voices = [], onClose, onSample, onSaved }: {
  mediaId: string; voice: Voice; voices?: Voice[]; onClose: () => void; onSample: () => void; onSaved: () => void;
}) {
  const toast = useToast();
  const [name, setName] = useState("");
  const [color, setColor] = useState<string>(SPEAKER_COLORS[0]);
  const [known, setKnown] = useState<Speaker[]>([]);
  const [target, setTarget] = useState(voice.speakerId ?? "");
  const [locals, setLocals] = useState(voice.locals);
  const [saving, setSaving] = useState(false);
  const [query, setQuery] = useState("");
  useEffect(() => { api.speakers().then(setKnown).catch(toast.error); }, [toast]);
  const save = async (mode: "label" | "unlink" | "noise" = "label") => {
    if (saving) return;
    setSaving(true);
    try {
      const result = await api.labelVoices({ mediaId, locals, speakerId: mode === "label" && target ? target : undefined,
        name: name.trim(), color, noise: mode === "noise", unlink: mode === "unlink" });
      const label = target ? known.find(s => s.id === target)?.name ?? voice.name : name.trim();
      toast.success(mode === "unlink" ? "Voice unlinked" : `${mode === "noise" ? "Marked as noise" : `Labelled as ${label}`}${result.matched ? ` · matched ${result.matched} other voices in ${result.recordings} recordings` : ""}`);
      onSaved(); onClose();
    } catch (e) { toast.error(e); } finally { setSaving(false); }
  };
  const others = voices.filter(v => !voice.locals.includes(v.local) && !v.named);
  return <Dialog open onOpenChange={open => !open && !saving && onClose()} title={`Label ${voice.name}`}
    description="Connect this voice to a saved person. Their voice fingerprints help identify them in other recordings."
    footer={<>
      <Button variant="ghost" icon={Play} onClick={onSample}>Play a sample</Button>
      {voice.named && <Button variant="ghost" disabled={saving} onClick={() => void save("unlink")}>Unlink</Button>}
      <Button variant="ghost" disabled={saving} onClick={() => void save("noise")}>Noise</Button>
      <Button variant="ghost" onClick={onClose} disabled={saving}>Cancel</Button>
      <Button variant="primary" disabled={saving || (!target && !name.trim())} onClick={() => void save()}>Save</Button>
    </>}>
    <label className="field">Find a saved speaker<input type="search" value={query} onChange={e => setQuery(e.target.value)} placeholder="Search by name" /></label>
    <div className="voice-options" role="radiogroup" aria-label="Assign to speaker">
      <button type="button" role="radio" aria-checked={!target} onClick={() => setTarget("")}>＋ New speaker</button>
      {known.filter(s => s.name.toLowerCase().includes(query.trim().toLowerCase())).map(s => <button type="button" role="radio" key={s.id}
        aria-checked={target === s.id} onClick={() => setTarget(s.id)}>
        <i style={{ background: speakerColor(s.color,s.name) }} />{s.name}{s.is_noise ? " · Noise" : ""}
      </button>)}
    </div>
    {!target && <><label className="field">New speaker name<input value={name} onChange={e => setName(e.target.value)} maxLength={200} /></label>
      <ColorPicker value={color} onChange={setColor} /></>}
    {voice.locals.length > 1 && <p className="muted">This changes all {voice.locals.length} fingerprints grouped under this person in this recording.</p>}
    {!!others.length && <fieldset className="voice-extra"><legend>Also label these as the same person</legend>
      {others.map(v => <label key={v.local}><input type="checkbox" checked={locals.includes(v.local)} onChange={e => setLocals(prev => e.target.checked ? [...prev,v.local] : prev.filter(l => l !== v.local))} />
        {v.name} <span className="muted">{humanDuration(v.airtime)}</span></label>)}
    </fieldset>}
  </Dialog>;
}
