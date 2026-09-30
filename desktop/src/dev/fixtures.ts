// Synthetic archive for design review in a browser. No real recordings, names, or transcripts.
import type { Assignment, Media, Note, NoteMarker, Recording, ReviewState, SearchHit, Segment, Speaker } from "../lib/types.ts";

export function seeded(seed: number) {
  let s = seed >>> 0;
  return () => ((s = (Math.imul(s ^ (s >>> 15), 2246822507) + 0x9e3779b9) >>> 0) / 2 ** 32);
}

const COLLECTIONS = ["Tuesday Study", "Field Interviews", "Voice notes", "Conference 2025"];
const FIRST = ["Harbour", "Covenant", "Early", "Northern", "Quiet", "Open", "Winter", "Long", "Second", "River", "Evening", "Lantern"];
const SECOND = ["conversation", "interview", "session", "walkthrough", "gathering", "reflections", "panel", "review"];
const PALETTE = ["#e0a24b", "#6fb3d2", "#9ccf8a", "#d68ab4", "#a79bdc", "#e57f6a", "#5fc4b8", "#c9b458", "#8fa3c8"];

export const speakerList: Speaker[] = [
  "Ada Marsh", "Tomás Ruiz", "Priya Natarajan", "Grace Holloway", "Samuel Okafor",
  "Lena Fischer", "Marcus Bell", "Ines Duarte", "Owen Carter",
].map((name, i) => ({
  id: `spk-${i + 1}`,
  name,
  color: i % 4 === 3 ? null : PALETTE[i],
  notes: i === 0 ? "Leads the Tuesday study; often opens with a summary." : i === 4 ? "Interviewed twice in the field series." : null,
  recordings: 30 - i * 3,
  airtime: (9 - i) * 5400 + 600,
}));

const SENTENCES = [
  "Let's start where we left off last week, with the question about memory.",
  "I kept thinking about how an archive changes the way people remember a conversation.",
  "When you can return to the exact words, you stop arguing about what was said.",
  "That was the moment the room went quiet, and everyone leaned in.",
  "We recorded every session so nobody had to take notes by hand.",
  "The harbour meeting is the one people keep asking about.",
  "I think the transcript misses some of the laughter, but the meaning is there.",
  "Could you say more about what you meant by a living record?",
  "Sure. A living record is one you can search, annotate, and share a piece of.",
  "The part about the lantern stuck with me for days afterwards.",
  "Honestly, I didn't expect the discussion to go in that direction.",
  "We should mark this passage so we can find it again next month.",
  "There's a difference between hearing something and understanding it.",
  "Let me read the line again so we're all looking at the same thing.",
  "Two speakers were talking over each other here, so it's worth listening again.",
  "That's a good point, and it connects to what Ada said earlier.",
  "I'd like to export this bit and send it to the others who missed it.",
  "The archive now holds more than two thousand recordings.",
  "We should compare this with the interview from the northern trip.",
  "It sounds simple, but it took us a long time to agree on it.",
  "Can we pause for a second and come back to the second question?",
  "Everyone remembers the story slightly differently, which is the point.",
  "I'll leave a note on this section so we can discuss it next time.",
  "Thanks, everyone. Same time next week.",
];

const pad2 = (n: number) => String(n).padStart(2, "0");
const reviewFor = (n: number): ReviewState => (n % 5 === 0 ? "reviewed" : n % 4 === 1 ? "in_review" : "unreviewed");

function isoDaysAgo(days: number): string {
  const d = new Date(Date.UTC(2025, 8, 30) - days * 86_400_000);
  return `${d.getUTCFullYear()}${pad2(d.getUTCMonth() + 1)}${pad2(d.getUTCDate())}`;
}

export const mediaList: Media[] = Array.from({ length: 48 }, (_, i) => {
  const n = i + 1;
  const rand = seeded(n * 97);
  const audio = n % 3 === 0;
  const collection = COLLECTIONS[i % COLLECTIONS.length];
  const duration = n === 1 ? 600 : Math.round(300 + rand() * 10500);
  const transcribed = n % 7 !== 0;
  const named = transcribed ? Math.floor(rand() * 5) : 0;
  const picks = [...speakerList].sort(() => rand() - 0.5).slice(0, named);
  const position = [1, 4, 6, 11].includes(n) ? Math.round(duration * 0.3) : 0;
  return {
    id: `rec-${pad2(n)}`,
    title: `${FIRST[i % FIRST.length]} ${SECOND[(i * 5) % SECOND.length]}${n % 6 === 0 ? " with guests from the northern chapter" : ""}`,
    channel: collection,
    date: isoDaysAgo(i * 11 + Math.floor(rand() * 5)),
    duration,
    path: `/archive/${collection.replace(/\s/g, "_")}/rec-${pad2(n)}.${audio ? "ogg" : "mp4"}`,
    transcript: transcribed ? `/archive/transcripts/rec-${pad2(n)}.md` : null,
    words: transcribed ? Math.round(duration * 2.4) : 0,
    status: transcribed ? "complete" : "ready",
    kind: audio ? "audio" : "video",
    starred: [2, 5, 9].includes(n) ? 1 : 0,
    review_state: reviewFor(n),
    position,
    opened_at: position ? `2025-09-${pad2(28 - n)} 10:00:00` : null,
    speaker_count: named + (transcribed ? 1 : 0),
    speakers: picks.slice(0, 3).map((s, k) => ({ name: s.name, color: s.color, airtime: Math.round(duration / (k + 2)) })),
    speaker_total: picks.length,
  };
});

const byId = new Map(mediaList.map((m) => [m.id, m]));

function segmentsFor(media: Media): Segment[] {
  if (!media.transcript) return [];
  const rand = seeded(media.id.length * 1_000 + Number(media.id.slice(4)));
  const out: Segment[] = [];
  let t = 1.2;
  let speaker = 0;
  let k = Number(media.id.slice(4));
  while (t < media.duration - 2) {
    const length = 4 + rand() * 5;
    if (rand() < 0.35) speaker = Math.floor(rand() * 4);
    const end = Math.min(media.duration - 0.5, t + length);
    out.push({ start: Math.round(t * 100) / 100, end: Math.round(end * 100) / 100, text: SENTENCES[k++ % SENTENCES.length], speaker: `S${speaker}` });
    t = end + rand() * 1.4;
  }
  return out;
}

export function recordingFor(id: string): Recording {
  const media = byId.get(id) ?? mediaList[0];
  const segments = segmentsFor(media);
  const airtime = (local: string) => segments.filter((s) => s.speaker === local).reduce((sum, s) => sum + s.end - s.start, 0);
  const people = speakerList.slice(Number(media.id.slice(4)) % 5);
  const assignments: Assignment[] = segments.length
    ? ["S0", "S1", "S2", "S3"].map((local, i) => ({
        local_id: local,
        speaker_id: i < 2 ? people[i].id : null,
        name: i < 2 ? people[i].name : null,
        color: i < 2 ? people[i].color : null,
        airtime: Math.round(airtime(local)),
      }))
    : [];
  const notes: NoteMarker[] = segments.length
    ? [
        { id: `${id}-n1`, title: "Where the room went quiet", start: Math.round(media.duration * 0.2), end: Math.round(media.duration * 0.2) + 40 },
        { id: `${id}-n2`, title: "Living record definition", start: Math.round(media.duration * 0.55), end: Math.round(media.duration * 0.55) + 25 },
      ]
    : [];
  return { media, segments, assignments, notes, model: "nvidia/nemotron-3.5-asr-streaming-0.6b" };
}

export const notesList: Note[] = [
  { id: "note-1", title: "Where the room went quiet", body: "Worth playing for the group next week — the pause says as much as the words.", quote: "That was the moment the room went quiet, and everyone leaned in.", media_id: "rec-01", media_title: mediaList[0].title, start: 120, end: 160, created_at: "2025-09-28 09:12:00" },
  { id: "note-2", title: "Living record definition", body: "Use this as the working definition in the handbook.", quote: "A living record is one you can search, annotate, and share a piece of.", media_id: "rec-02", media_title: mediaList[1].title, start: 610, end: 640, created_at: "2025-09-26 16:40:00" },
  { id: "note-3", title: "Compare with the northern trip", body: "Two accounts of the same evening; the details differ in interesting ways.", media_id: "rec-04", media_title: mediaList[3].title, start: 1320, end: 1400, created_at: "2025-09-20 11:05:00" },
  { id: "note-4", title: "Questions for the next session", body: "1. What changed after the harbour meeting?\n2. Who kept the lantern?", created_at: "2025-09-18 08:30:00" },
  { id: "note-5", title: "Laughter the transcript misses", body: "Mark moments where tone matters more than text.", quote: "I think the transcript misses some of the laughter, but the meaning is there.", media_id: "rec-05", media_title: mediaList[4].title, start: 45, end: 70, created_at: "2025-09-10 19:22:00" },
  { id: "note-6", title: "Export for absent members", body: "Send the second half to those who missed it.", media_id: "rec-06", media_title: mediaList[5].title, start: 2400, end: 2700, created_at: "2025-09-02 14:00:00" },
];

export const docsList = [
  { id: "doc-1", title: "Study guide — memory and record", length: 18_400 },
  { id: "doc-2", title: "Field interview protocol", length: 7_200 },
  { id: "doc-3", title: "Harbour meeting summary", length: 3_900 },
  { id: "doc-4", title: "Glossary", length: 1_250 },
  { id: "doc-5", title: "Reading list", length: 820 },
];

export function docBody(id: string): string {
  const title = docsList.find((d) => d.id === id)?.title ?? "Document";
  return `# ${title}

This guide collects the questions we return to most often, with links back to the moments they came from.

## Why keep a record

A recording holds more than words: pauses, laughter, the order people spoke in. The transcript makes it *searchable*; the recording keeps it **honest**.

> When you can return to the exact words, you stop arguing about what was said.

## How we work

1. Record every session.
2. Transcribe and name the voices.
3. Mark passages worth returning to.

- Keep notes short.
- Link notes that answer each other.
- Export only what you need to share.

### A small example

\`\`\`
[12:03] Ada: Let's start where we left off last week.
\`\`\`

Read more in the [project notes](https://example.org/notes).

---

Last revised after the harbour meeting.`;
}

export function peaksFor(id: string): number[] {
  const rand = seeded(id.length * 31 + Number(id.slice(4) || 1));
  let level = 0.4;
  return Array.from({ length: 2000 }, (_, i) => {
    level = Math.min(1, Math.max(0.08, level + (rand() - 0.5) * 0.18));
    const pause = i % 173 < 6 ? 0.25 : 1;
    return Math.max(0.05, Math.min(1, level * pause * (0.75 + rand() * 0.25)));
  });
}

export function thumbnailFor(id: string): string | null {
  const media = byId.get(id);
  if (!media || media.kind === "audio") return null;
  const rand = seeded(Number(id.slice(4)) * 13);
  const hue = Math.round(rand() * 360);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 320 180"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="hsl(${hue} 35% 30%)"/><stop offset="1" stop-color="hsl(${(hue + 40) % 360} 45% 16%)"/></linearGradient></defs><rect width="320" height="180" fill="url(#g)"/><circle cx="${90 + rand() * 140}" cy="${60 + rand() * 60}" r="${40 + rand() * 40}" fill="hsl(${hue} 60% 70% / 0.18)"/><rect x="${20 + rand() * 60}" y="120" width="${120 + rand() * 120}" height="12" rx="6" fill="hsl(0 0% 100% / 0.14)"/></svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

let wavUrl: string | null = null;
/** An 8-bit mono 2 kHz silent WAV so the player can play in a browser. */
export function silentWav(seconds: number): string {
  if (wavUrl) return wavUrl;
  const rate = 2000;
  const samples = rate * seconds;
  const buffer = new ArrayBuffer(44 + samples);
  const view = new DataView(buffer);
  const text = (offset: number, s: string) => [...s].forEach((c, i) => view.setUint8(offset + i, c.charCodeAt(0)));
  text(0, "RIFF");
  view.setUint32(4, 36 + samples, true);
  text(8, "WAVE");
  text(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, rate, true);
  view.setUint32(28, rate, true);
  view.setUint16(32, 1, true);
  view.setUint16(34, 8, true);
  text(36, "data");
  view.setUint32(40, samples, true);
  new Uint8Array(buffer, 44).fill(128);
  wavUrl = URL.createObjectURL(new Blob([buffer], { type: "audio/wav" }));
  return wavUrl;
}

export function searchHits(query: string): SearchHit[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const hits: SearchHit[] = [];
  for (const media of mediaList.slice(0, 12)) {
    const rec = recordingFor(media.id);
    const names = new Map(rec.assignments.map((a) => [a.local_id, a]));
    for (const s of rec.segments) {
      const at = s.text.toLowerCase().indexOf(q);
      if (at < 0) continue;
      const a = names.get(s.speaker ?? "");
      hits.push({
        id: media.id, title: media.title, channel: media.channel, date: media.date, text: s.text,
        marked: `${s.text.slice(0, at)}\u0002${s.text.slice(at, at + q.length)}\u0003${s.text.slice(at + q.length)}`,
        start: s.start, speaker: s.speaker ?? null, speaker_name: a?.name ?? null, speaker_color: a?.color ?? null,
      });
      if (hits.length >= 200) return hits;
    }
  }
  return hits;
}

export function paletteFor(query: string) {
  const q = query.trim().toLowerCase();
  const match = (s: string) => s.toLowerCase().includes(q);
  if (!q) {
    return {
      recordings: mediaList.filter((m) => m.opened_at).slice(0, 6).map(({ id, title, channel, date }) => ({ id, title, channel, date })),
      speakers: [], notes: [], documents: [],
    };
  }
  return {
    recordings: mediaList.filter((m) => match(m.title) || match(m.channel)).slice(0, 6).map(({ id, title, channel, date }) => ({ id, title, channel, date })),
    speakers: speakerList.filter((s) => match(s.name)).slice(0, 6).map(({ id, name, color }) => ({ id, name, color })),
    notes: notesList.filter((n) => match(n.title) || match(n.body)).slice(0, 6).map((n) => ({ id: n.id!, title: n.title, media_id: n.media_id ?? null, start: n.start ?? null })),
    documents: docsList.filter((d) => match(d.title)).slice(0, 6).map(({ id, title }) => ({ id, title })),
  };
}
