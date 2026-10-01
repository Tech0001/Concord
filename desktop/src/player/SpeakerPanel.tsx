import type { CSSProperties } from "react";
import { CornerDownRight, Users } from "lucide-react";
import { count, humanDuration } from "../lib/format.ts";
import { IconButton } from "../ui/Button.tsx";
import { Empty } from "../ui/Empty.tsx";
import { groupVoices, type Voice } from "./voices.ts";

export function SpeakerPanel({
  voices,
  onName,
  onFirstLine,
}: {
  voices: Map<string, Voice>;
  onName: (voice: Voice) => void;
  onFirstLine: (voice: Voice) => void;
}) {
  const list = groupVoices(voices);
  const unidentified = list.filter(v => !v.named);
  return (
    <section className="speaker-panel" aria-label="Speakers in this recording">
      <header className="panel-head">
        <h3>In this recording</h3>
        <span className="muted num">{count(list.length, "speaker")}</span>
        {!!unidentified.length && <button type="button" onClick={() => onFirstLine(unidentified[0])}>{unidentified.length} unidentified · Listen</button>}
      </header>
      {list.length === 0 ? (
        <Empty icon={Users} title="No voices yet" text="Transcribe this recording to see who speaks." />
      ) : (
        <ul className="voice-list">
          {list.map((v) => (
            <li key={v.local} className="voice-row" style={{ "--speaker": v.color } as CSSProperties}>
              <button
                type="button"
                className="voice-main"
                onClick={() => onName(v)}
                title={v.named ? "Change speaker label" : "Name this voice"}
              >
                <i className="speaker-dot" aria-hidden />
                <span className={v.named ? "voice-name" : "voice-name is-unnamed"}>{v.name}</span>
                {v.locals.length > 1 && <span className="muted num">{count(v.locals.length, "voice")}</span>}
                {!v.named && <span className="voice-action">Name</span>}
                <span className="voice-airtime num">{humanDuration(v.airtime)}</span>
              </button>
              <IconButton label={`Go to ${v.name}'s first line`} icon={CornerDownRight} size="sm" onClick={() => onFirstLine(v)} />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
