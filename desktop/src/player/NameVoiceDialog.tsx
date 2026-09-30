import { useEffect, useId, useState } from "react";
import { Play } from "lucide-react";
import { api } from "../lib/ipc.ts";
import { Button } from "../ui/Button.tsx";
import { Dialog } from "../ui/Dialog.tsx";
import { useToast } from "../ui/Toasts.tsx";
import type { Voice } from "./voices.ts";

export function NameVoiceDialog({
  mediaId,
  voice,
  onClose,
  onSample,
  onSaved,
}: {
  mediaId: string;
  voice: Voice;
  onClose: () => void;
  onSample: () => void;
  onSaved: () => void;
}) {
  const toast = useToast();
  const listId = useId();
  const [name, setName] = useState(voice.named ? voice.name : "");
  const [known, setKnown] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    api
      .speakers()
      .then((list) => setKnown(list.map((s) => s.name)))
      .catch(() => {
        /* Suggestions are optional; typing a name still works. */
      });
  }, []);
  const save = async () => {
    setSaving(true);
    try {
      await api.assignSpeaker(mediaId, voice.local, name.trim());
      toast.success(`Voice named ${name.trim()}`);
      onSaved();
      onClose();
    } catch (e) {
      toast.error(e);
    } finally {
      setSaving(false);
    }
  };
  return (
    <Dialog
      open
      onOpenChange={(open) => !open && onClose()}
      title="Name this voice"
      description="Use an existing name to connect this voice across recordings."
      size="sm"
      footer={
        <>
          <Button variant="ghost" icon={Play} onClick={onSample} className="dialog-foot-start">
            Play a sample
          </Button>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" disabled={!name.trim() || saving} onClick={save}>
            Save
          </Button>
        </>
      }
    >
      <label className="field">
        Name
        <input
          autoFocus
          list={listId}
          value={name}
          placeholder={voice.name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && name.trim() && void save()}
        />
        <datalist id={listId}>
          {known.map((n) => (
            <option key={n} value={n} />
          ))}
        </datalist>
      </label>
    </Dialog>
  );
}
