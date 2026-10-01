import type { Assignment, Segment } from "../lib/types.ts";
import { speakerColor, voiceLabel } from "../lib/speakers.ts";

export type Voice = {
  local: string;
  locals: string[];
  speakerId: string | null;
  name: string;
  color: string;
  named: boolean;
  airtime: number;
};

/** Every local voice in the transcript, named where an assignment has a name, loudest first. */
export function buildVoices(assignments: Assignment[], segments: Segment[]): Map<string, Voice> {
  const voices = new Map<string, Voice>();
  const measured = new Set<string>();
  for (const a of assignments) {
    voices.set(a.local_id, {
      local: a.local_id,
      locals: [a.local_id],
      speakerId: a.speaker_id,
      name: a.name ?? voiceLabel(a.local_id),
      color: speakerColor(a.color, a.name ?? a.local_id),
      named: !!a.name,
      airtime: a.airtime,
    });
    if (a.airtime > 0) measured.add(a.local_id);
  }
  for (const s of segments) {
    if (!s.speaker) continue;
    const v = voices.get(s.speaker);
    if (v) {
      if (!measured.has(s.speaker)) v.airtime += s.end - s.start;
    } else {
      voices.set(s.speaker, {
        local: s.speaker,
        locals: [s.speaker],
        speakerId: null,
        name: voiceLabel(s.speaker),
        color: speakerColor(null, s.speaker),
        named: false,
        airtime: s.end - s.start,
      });
    }
  }
  return new Map([...voices].sort((a, b) => b[1].airtime - a[1].airtime));
}

/** Keep each fingerprint for labeling, but present saved people once in the recording. */
export function groupVoices(voices: Map<string, Voice>): Voice[] {
  const groups = new Map<string, Voice>();
  for (const v of voices.values()) {
    const key = v.speakerId ? `person:${v.speakerId}` : `local:${v.local}`;
    const group = groups.get(key);
    if (group) {
      group.locals.push(...v.locals);
      group.airtime += v.airtime;
    } else groups.set(key, { ...v, locals: [...v.locals] });
  }
  return [...groups.values()].sort((a, b) => b.airtime - a.airtime);
}
