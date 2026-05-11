import { getDb, getQueueEntry, parseTranscriptSegments } from "./db";

// ---------------------------------------------------------------
// Voice profiles (cross-video speaker identity)
//
// Three tables (all created in db.ts SCHEMA):
//   speakers                       — one row per labeled global voice
//                                     ("Joe Rogan", "Lex Fridman", or noise)
//   speaker_embeddings             — count-weighted centroid per global
//                                     speaker. Updates as new samples are
//                                     labeled to it.
//   video_speaker_assignments      — (video, local_speaker) → speaker_id.
//                                     Stores the per-video centroid so we
//                                     can auto-match new speakers across
//                                     the archive.
// ---------------------------------------------------------------

/** Cosine distance threshold for auto-matching a video's speaker centroid
 *  against an existing global speaker. Tighter than the within-video
 *  threshold (0.65) because cross-video false-merges are more confusing
 *  for the user than leaving an unidentified speaker for manual labeling.
 *  Matches that exceed this threshold leave speaker_id = NULL so the
 *  user can decide. */
export const SPEAKER_AUTOMATCH_THRESHOLD = 0.55;

export interface Speaker {
  id: string;
  name: string;
  display_color: string | null;
  notes: string | null;
  /** When 1, this is a "noise / ignore" speaker — used as a bucket for
   *  spurious chips (background music, audio artifacts, brief
   *  voiceovers) that aren't real distinct people. UI hides these from
   *  Library badges, the Search filter dropdown, and de-emphasizes them
   *  on the Speakers page. Auto-rescan still works against them so new
   *  noise auto-folds into the bucket. */
  is_noise: number;
  created_at: string;
  updated_at: string;
}

export interface SpeakerEmbedding {
  speaker_id: string;
  embedding: Float32Array;
  sample_count: number;
  updated_at: string;
}

export interface VideoSpeakerAssignment {
  video_id: string;
  channel_id: string;
  local_speaker: string;
  speaker_id: string | null;
  centroid: Float32Array;
  confidence: number | null;
  sample_start: number | null;
  sample_end: number | null;
  airtime_seconds: number;
}

function f32ToBuffer(arr: Float32Array): Buffer {
  return Buffer.from(arr.buffer, arr.byteOffset, arr.byteLength);
}

function bufferToF32(buf: Buffer | Uint8Array): Float32Array {
  return new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
}

function cosineDistance(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) return 2.0;
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  if (denom === 0) return 2.0;
  return 1.0 - dot / denom;
}

export function getAllSpeakers(): Speaker[] {
  return getDb().prepare(`
    SELECT id, name, display_color, notes, is_noise, created_at, updated_at
    FROM speakers ORDER BY name COLLATE NOCASE
  `).all() as Speaker[];
}

export function getSpeakerById(id: string): Speaker | undefined {
  return getDb().prepare(`
    SELECT id, name, display_color, notes, is_noise, created_at, updated_at
    FROM speakers WHERE id = ?
  `).get(id) as Speaker | undefined;
}

export function createSpeaker(args: { id: string; name: string; displayColor?: string | null; notes?: string | null; isNoise?: boolean }): Speaker {
  const { id, name, displayColor = null, notes = null, isNoise = false } = args;
  getDb().prepare(`
    INSERT INTO speakers (id, name, display_color, notes, is_noise)
    VALUES (?, ?, ?, ?, ?)
  `).run(id, name, displayColor, notes, isNoise ? 1 : 0);
  return getSpeakerById(id)!;
}

export function updateSpeaker(id: string, fields: { name?: string; displayColor?: string | null; notes?: string | null; isNoise?: boolean }): Speaker | undefined {
  const sets: string[] = [];
  const params: any[] = [];
  if (fields.name !== undefined) { sets.push("name = ?"); params.push(fields.name); }
  if (fields.displayColor !== undefined) { sets.push("display_color = ?"); params.push(fields.displayColor); }
  if (fields.notes !== undefined) { sets.push("notes = ?"); params.push(fields.notes); }
  if (fields.isNoise !== undefined) { sets.push("is_noise = ?"); params.push(fields.isNoise ? 1 : 0); }
  if (sets.length === 0) return getSpeakerById(id);
  sets.push("updated_at = datetime('now')");
  params.push(id);
  getDb().prepare(`UPDATE speakers SET ${sets.join(", ")} WHERE id = ?`).run(...params);
  return getSpeakerById(id);
}

/**
 * Merge two global speakers: repoint every video_speaker_assignments row
 * from `sourceId` to `targetId`, fold the source centroid into the target
 * via count-weighted average, and delete the source speaker row.
 *
 * Returns counts so the UI can report what happened. Atomic — all-or-nothing.
 */
export function mergeSpeakers(
  sourceId: string,
  targetId: string,
): { reassigned: number; centroidUpdated: boolean } {
  if (sourceId === targetId) {
    throw new Error("Cannot merge a speaker into itself");
  }
  const db = getDb();
  const source = getSpeakerById(sourceId);
  const target = getSpeakerById(targetId);
  if (!source) throw new Error(`Source speaker ${sourceId} not found`);
  if (!target) throw new Error(`Target speaker ${targetId} not found`);

  let centroidUpdated = false;
  const result = db.transaction(() => {
    const r = db.prepare(`
      UPDATE video_speaker_assignments
      SET speaker_id = ?, updated_at = datetime('now')
      WHERE speaker_id = ?
    `).run(targetId, sourceId);

    const sourceEmb = getSpeakerEmbedding(sourceId);
    const targetEmb = getSpeakerEmbedding(targetId);
    if (sourceEmb && targetEmb && sourceEmb.embedding.length === targetEmb.embedding.length) {
      const total = sourceEmb.sample_count + targetEmb.sample_count;
      const merged = new Float32Array(targetEmb.embedding.length);
      for (let i = 0; i < merged.length; i++) {
        merged[i] = (
          sourceEmb.embedding[i] * sourceEmb.sample_count
          + targetEmb.embedding[i] * targetEmb.sample_count
        ) / total;
      }
      setSpeakerEmbedding(targetId, merged, total);
      centroidUpdated = true;
    } else if (sourceEmb && !targetEmb) {
      setSpeakerEmbedding(targetId, sourceEmb.embedding, sourceEmb.sample_count);
      centroidUpdated = true;
    }

    db.prepare("DELETE FROM speakers WHERE id = ?").run(sourceId);

    return { reassigned: r.changes, centroidUpdated };
  })();
  return result;
}

/** Returns the singleton noise speaker, creating one with a fixed name
 *  + grey color if none exists yet. Used by the "Mark as noise" flow.
 *  ID is generated by caller (db.ts can't import nanoid cleanly). */
export function getOrCreateNoiseSpeaker(generatedIdIfMissing: string): Speaker {
  const existing = getDb().prepare(`
    SELECT id, name, display_color, notes, is_noise, created_at, updated_at
    FROM speakers WHERE is_noise = 1
    ORDER BY created_at ASC LIMIT 1
  `).get() as Speaker | undefined;
  if (existing) return existing;
  return createSpeaker({
    id: generatedIdIfMissing,
    name: "(noise)",
    displayColor: "#64748b",
    isNoise: true,
  });
}

export function deleteSpeaker(id: string): boolean {
  // ON DELETE CASCADE on speaker_embeddings; ON DELETE SET NULL on
  // video_speaker_assignments.speaker_id (so the video-local assignments
  // become unidentified again instead of disappearing).
  const r = getDb().prepare("DELETE FROM speakers WHERE id = ?").run(id);
  return r.changes > 0;
}

export function getSpeakerEmbedding(speakerId: string): SpeakerEmbedding | undefined {
  const row = getDb().prepare(`
    SELECT speaker_id, embedding, sample_count, updated_at
    FROM speaker_embeddings WHERE speaker_id = ?
  `).get(speakerId) as { speaker_id: string; embedding: Buffer; sample_count: number; updated_at: string } | undefined;
  if (!row) return undefined;
  return { ...row, embedding: bufferToF32(row.embedding) };
}

export function getAllSpeakerEmbeddings(): SpeakerEmbedding[] {
  const rows = getDb().prepare(`
    SELECT speaker_id, embedding, sample_count, updated_at FROM speaker_embeddings
  `).all() as { speaker_id: string; embedding: Buffer; sample_count: number; updated_at: string }[];
  return rows.map(r => ({ ...r, embedding: bufferToF32(r.embedding) }));
}

/** Insert OR update the global centroid for a speaker. Caller decides
 *  whether to compute a fresh centroid (first label) or merge in a new
 *  sample (count-weighted average) — this just stores whatever it's given. */
export function setSpeakerEmbedding(speakerId: string, embedding: Float32Array, sampleCount: number): void {
  getDb().prepare(`
    INSERT INTO speaker_embeddings (speaker_id, embedding, sample_count, updated_at)
    VALUES (?, ?, ?, datetime('now'))
    ON CONFLICT(speaker_id) DO UPDATE SET
      embedding = excluded.embedding,
      sample_count = excluded.sample_count,
      updated_at = excluded.updated_at
  `).run(speakerId, f32ToBuffer(embedding), sampleCount);
}

/** Find the closest existing speaker by cosine distance to `embedding`.
 *  Returns null if no speaker exists OR closest is past the threshold.
 *  Threshold defaults to SPEAKER_AUTOMATCH_THRESHOLD; pass a tighter
 *  value for stricter manual matching. */
export function findClosestSpeaker(embedding: Float32Array, threshold = SPEAKER_AUTOMATCH_THRESHOLD): { speaker_id: string; distance: number } | null {
  const all = getAllSpeakerEmbeddings();
  if (all.length === 0) return null;
  let best: { speaker_id: string; distance: number } | null = null;
  for (const e of all) {
    const dist = cosineDistance(embedding, e.embedding);
    if (best === null || dist < best.distance) {
      best = { speaker_id: e.speaker_id, distance: dist };
    }
  }
  if (best && best.distance <= threshold) return best;
  return null;
}

/** Idempotent upsert. Used during transcription to record one video's
 *  per-local-speaker centroids + auto-match attempt. */
export function upsertVideoSpeakerAssignment(args: {
  videoId: string;
  channelId: string;
  localSpeaker: string;
  speakerId: string | null;
  centroid: Float32Array;
  confidence: number | null;
  sampleStart: number | null;
  sampleEnd: number | null;
  airtimeSeconds: number;
}): void {
  getDb().prepare(`
    INSERT INTO video_speaker_assignments
      (video_id, channel_id, local_speaker, speaker_id, centroid, confidence,
       sample_start, sample_end, airtime_seconds, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(video_id, channel_id, local_speaker) DO UPDATE SET
      speaker_id = excluded.speaker_id,
      centroid = excluded.centroid,
      confidence = excluded.confidence,
      sample_start = excluded.sample_start,
      sample_end = excluded.sample_end,
      airtime_seconds = excluded.airtime_seconds,
      updated_at = excluded.updated_at
  `).run(
    args.videoId, args.channelId, args.localSpeaker, args.speakerId,
    f32ToBuffer(args.centroid), args.confidence,
    args.sampleStart, args.sampleEnd, args.airtimeSeconds,
  );
}

export function getVideoSpeakerAssignments(videoId: string, channelId: string): VideoSpeakerAssignment[] {
  const rows = getDb().prepare(`
    SELECT video_id, channel_id, local_speaker, speaker_id, centroid, confidence,
           sample_start, sample_end, airtime_seconds
    FROM video_speaker_assignments
    WHERE video_id = ? AND channel_id = ?
    ORDER BY airtime_seconds DESC
  `).all(videoId, channelId) as Array<Omit<VideoSpeakerAssignment, "centroid"> & { centroid: Buffer }>;
  return rows.map(r => ({ ...r, centroid: bufferToF32(r.centroid) }));
}

export interface SpeakerWithStats extends Speaker {
  total_airtime_seconds: number;
  appearance_count: number;     // distinct videos
  has_embedding: number;        // 1 if speaker_embeddings row exists, else 0
}

/** Speakers list with rolled-up stats — the "Speakers" page main view.
 *  Includes is_noise so the UI can render those in their own subsection. */
export function getSpeakersWithStats(): SpeakerWithStats[] {
  return getDb().prepare(`
    SELECT
      s.id, s.name, s.display_color, s.notes, s.is_noise, s.created_at, s.updated_at,
      COALESCE(SUM(vsa.airtime_seconds), 0) AS total_airtime_seconds,
      COUNT(DISTINCT vsa.video_id || '|' || vsa.channel_id) AS appearance_count,
      CASE WHEN se.speaker_id IS NOT NULL THEN 1 ELSE 0 END AS has_embedding
    FROM speakers s
    LEFT JOIN video_speaker_assignments vsa ON vsa.speaker_id = s.id
    LEFT JOIN speaker_embeddings se ON se.speaker_id = s.id
    GROUP BY s.id
    ORDER BY s.is_noise ASC, total_airtime_seconds DESC, s.name COLLATE NOCASE
  `).all() as SpeakerWithStats[];
}

export interface UnidentifiedAssignment extends VideoSpeakerAssignment {
  video_title: string;
  video_url: string;
  video_path: string | null;
  channel_name: string | null;
  upload_date: string | null;
}

/** All video-local speakers without a global speaker mapping —
 *  the "needs labeling" list for the UI. Ordered by airtime so
 *  dominant unidentifieds get attention first. */
export function getUnidentifiedAssignments(limit = 200): UnidentifiedAssignment[] {
  const rows = getDb().prepare(`
    SELECT
      vsa.video_id, vsa.channel_id, vsa.local_speaker, vsa.speaker_id,
      vsa.centroid, vsa.confidence, vsa.sample_start, vsa.sample_end,
      vsa.airtime_seconds,
      q.title AS video_title, q.url AS video_url, q.video_path,
      c.name AS channel_name, q.upload_date
    FROM video_speaker_assignments vsa
    JOIN video_queue q ON q.video_id = vsa.video_id AND q.channel_id = vsa.channel_id
    LEFT JOIN channels c ON c.id = vsa.channel_id
    WHERE vsa.speaker_id IS NULL
    ORDER BY vsa.airtime_seconds DESC
    LIMIT ?
  `).all(limit) as Array<Omit<UnidentifiedAssignment, "centroid"> & { centroid: Buffer }>;
  return rows.map(r => ({ ...r, centroid: bufferToF32(r.centroid) }));
}

export interface SpeakerAppearance {
  video_id: string;
  channel_id: string;
  channel_name: string | null;
  title: string;
  url: string;
  video_path: string | null;
  upload_date: string | null;
  local_speaker: string;
  airtime_seconds: number;
  sample_start: number | null;
  sample_end: number | null;
}

/** All videos where a given speaker appears, with their local label
 *  and airtime in each. Used by the speaker-detail view. */
export function getSpeakerAppearances(speakerId: string): SpeakerAppearance[] {
  return getDb().prepare(`
    SELECT
      vsa.video_id, vsa.channel_id, c.name AS channel_name,
      q.title, q.url, q.video_path, q.upload_date,
      vsa.local_speaker, vsa.airtime_seconds,
      vsa.sample_start, vsa.sample_end
    FROM video_speaker_assignments vsa
    JOIN video_queue q ON q.video_id = vsa.video_id AND q.channel_id = vsa.channel_id
    LEFT JOIN channels c ON c.id = vsa.channel_id
    WHERE vsa.speaker_id = ?
    ORDER BY vsa.airtime_seconds DESC
  `).all(speakerId) as SpeakerAppearance[];
}

/** Per-video summary of which speakers appear, for the Library badges.
 *  Returns top speakers (those with global identity) ordered by airtime. */
export interface VideoSpeakerSummary {
  speaker_id: string;
  name: string;
  display_color: string | null;
  airtime_seconds: number;
  local_speaker: string;
}

export function getVideoSpeakerSummary(videoId: string, channelId: string): VideoSpeakerSummary[] {
  // Excludes is_noise speakers — Library badges and per-video summary
  // shouldn't surface "(noise)" as one of a video's speakers. The
  // VideoDrawer's per-segment chips still SHOW the noise speaker name
  // (so the user can see what's marked as noise) — those use a
  // different fetch path.
  return getDb().prepare(`
    SELECT
      s.id AS speaker_id, s.name, s.display_color,
      vsa.airtime_seconds, vsa.local_speaker
    FROM video_speaker_assignments vsa
    JOIN speakers s ON s.id = vsa.speaker_id
    WHERE vsa.video_id = ? AND vsa.channel_id = ? AND s.is_noise = 0
    ORDER BY vsa.airtime_seconds DESC
  `).all(videoId, channelId) as VideoSpeakerSummary[];
}

/** Batched version of getVideoSpeakerSummary for the Library list view.
 *  Returns a map keyed by `video_id|channel_id` so the client can do
 *  one fetch per page-load instead of N per visible row.
 *
 *  Aggregates per global speaker — diarization often splits one real
 *  voice into multiple local clusters (S0, S1, S2), and the user typically
 *  labels all of them as the same global speaker. Summing airtime by
 *  speaker_id means the Library badges show each person once with their
 *  full airtime across all their fingerprints. */
export function getVideoSpeakerSummariesBatch(
  pairs: { video_id: string; channel_id: string }[],
): Record<string, VideoSpeakerSummary[]> {
  const out: Record<string, VideoSpeakerSummary[]> = {};
  if (pairs.length === 0) return out;

  // Build (?, ?), (?, ?) ... placeholder list. SQLite has a hard cap of
  // ~32k bound parameters, so chunk if a caller passes a huge batch.
  const CHUNK = 200; // per-call row count cap (= 400 params, well under limit)
  const stmt = (count: number) => getDb().prepare(`
    SELECT
      vsa.video_id, vsa.channel_id,
      s.id AS speaker_id, s.name, s.display_color,
      SUM(vsa.airtime_seconds) AS airtime_seconds,
      MIN(vsa.local_speaker)   AS local_speaker
    FROM video_speaker_assignments vsa
    JOIN speakers s ON s.id = vsa.speaker_id
    WHERE s.is_noise = 0 AND (vsa.video_id, vsa.channel_id) IN (${
      Array.from({ length: count }, () => "(?, ?)").join(", ")
    })
    GROUP BY vsa.video_id, vsa.channel_id, s.id
    ORDER BY airtime_seconds DESC
  `);

  for (let i = 0; i < pairs.length; i += CHUNK) {
    const slice = pairs.slice(i, i + CHUNK);
    const params: string[] = [];
    for (const p of slice) { params.push(p.video_id, p.channel_id); }
    const rows = stmt(slice.length).all(...params) as Array<VideoSpeakerSummary & { video_id: string; channel_id: string }>;
    for (const row of rows) {
      const key = `${row.video_id}|${row.channel_id}`;
      if (!out[key]) out[key] = [];
      const { video_id: _v, channel_id: _c, ...rest } = row;
      out[key].push(rest);
    }
  }
  return out;
}

/** Manually link (or unlink) a video-local speaker to a global speaker.
 *  Upserts: if no video_speaker_assignments row exists yet (e.g. the
 *  video was transcribed before Phase 1 added the centroid-saving step),
 *  inserts a stub row with an empty centroid so the assignment sticks.
 *  When centroid IS available, also folds it into the speaker's global
 *  centroid as a count-weighted moving average — improves match quality
 *  for future videos. Pass speakerId = null to unlink. */
export function assignVideoSpeakerToGlobal(args: {
  videoId: string;
  channelId: string;
  localSpeaker: string;
  speakerId: string | null;
}): void {
  const d = getDb();
  // Upsert. ON CONFLICT keeps the existing centroid + airtime when the
  // row already exists; for new rows we insert an empty centroid (we
  // don't have one for old pre-Phase 1 transcripts). The assignment
  // itself always wins.
  d.prepare(`
    INSERT INTO video_speaker_assignments
      (video_id, channel_id, local_speaker, speaker_id, centroid,
       confidence, sample_start, sample_end, airtime_seconds, updated_at)
    VALUES (?, ?, ?, ?, ?, NULL, NULL, NULL, 0, datetime('now'))
    ON CONFLICT(video_id, channel_id, local_speaker) DO UPDATE SET
      speaker_id = excluded.speaker_id,
      confidence = NULL,
      updated_at = datetime('now')
  `).run(
    args.videoId, args.channelId, args.localSpeaker, args.speakerId,
    Buffer.alloc(0),  // empty centroid — stub for old transcripts; ignored when zero-length
  );

  // If linking to a real speaker AND we have a non-empty centroid for
  // this video-local, fold it into the global speaker's centroid.
  if (args.speakerId === null) return;
  const va = d.prepare(`
    SELECT centroid FROM video_speaker_assignments
    WHERE video_id = ? AND channel_id = ? AND local_speaker = ?
  `).get(args.videoId, args.channelId, args.localSpeaker) as { centroid: Buffer } | undefined;
  if (!va || va.centroid.byteLength === 0) return;  // pre-Phase 1 transcript, no fingerprint to fold
  const newCentroid = bufferToF32(va.centroid);

  const existing = getSpeakerEmbedding(args.speakerId);
  if (!existing) {
    setSpeakerEmbedding(args.speakerId, newCentroid, 1);
    return;
  }
  // Weighted average + renormalize (centroids are stored normalized).
  const merged = new Float32Array(existing.embedding.length);
  const n = existing.sample_count;
  let normSq = 0;
  for (let i = 0; i < merged.length; i++) {
    merged[i] = (existing.embedding[i] * n + newCentroid[i]) / (n + 1);
    normSq += merged[i] * merged[i];
  }
  const norm = Math.sqrt(normSq);
  if (norm > 0) {
    for (let i = 0; i < merged.length; i++) merged[i] = merged[i] / norm;
  }
  setSpeakerEmbedding(args.speakerId, merged, n + 1);
}

/** Walk every video_speaker_assignments row with speaker_id IS NULL
 *  and a non-empty centroid, compare against the given global speaker's
 *  centroid, and auto-assign matches within the threshold. Returns how
 *  many matched.
 *
 *  Triggered automatically when a new global speaker is created (so a
 *  one-shot label finds all the prior appearances in your archive) and
 *  exposed as a manual button per-speaker for re-running after centroid
 *  updates from later labels. */
export function autoMatchUnidentifiedAgainstSpeaker(
  speakerId: string,
  threshold = SPEAKER_AUTOMATCH_THRESHOLD,
): number {
  const target = getSpeakerEmbedding(speakerId);
  if (!target) return 0;

  const rows = getDb().prepare(`
    SELECT video_id, channel_id, local_speaker, centroid
    FROM video_speaker_assignments
    WHERE speaker_id IS NULL
  `).all() as Array<{ video_id: string; channel_id: string; local_speaker: string; centroid: Buffer }>;

  const updateStmt = getDb().prepare(`
    UPDATE video_speaker_assignments
    SET speaker_id = ?, confidence = ?, updated_at = datetime('now')
    WHERE video_id = ? AND channel_id = ? AND local_speaker = ?
  `);

  let matched = 0;
  for (const row of rows) {
    if (row.centroid.byteLength === 0) continue;  // pre-Phase-1 stub
    const candidate = bufferToF32(row.centroid);
    const dist = cosineDistance(candidate, target.embedding);
    if (dist <= threshold) {
      updateStmt.run(speakerId, 1.0 - dist, row.video_id, row.channel_id, row.local_speaker);
      matched++;
    }
  }
  return matched;
}

/** Bulk variant: walks all unidentifieds and tries every known speaker,
 *  assigning each to the closest match within threshold. Used by the
 *  "Rescan all" button on the Speakers page. */
export function autoMatchAllUnidentified(threshold = SPEAKER_AUTOMATCH_THRESHOLD): number {
  const speakers = getAllSpeakerEmbeddings();
  if (speakers.length === 0) return 0;

  const rows = getDb().prepare(`
    SELECT video_id, channel_id, local_speaker, centroid
    FROM video_speaker_assignments
    WHERE speaker_id IS NULL
  `).all() as Array<{ video_id: string; channel_id: string; local_speaker: string; centroid: Buffer }>;

  const updateStmt = getDb().prepare(`
    UPDATE video_speaker_assignments
    SET speaker_id = ?, confidence = ?, updated_at = datetime('now')
    WHERE video_id = ? AND channel_id = ? AND local_speaker = ?
  `);

  let matched = 0;
  for (const row of rows) {
    if (row.centroid.byteLength === 0) continue;
    const candidate = bufferToF32(row.centroid);
    let bestDist = Infinity;
    let bestSpeakerId: string | null = null;
    for (const s of speakers) {
      const d = cosineDistance(candidate, s.embedding);
      if (d < bestDist) { bestDist = d; bestSpeakerId = s.speaker_id; }
    }
    if (bestSpeakerId !== null && bestDist <= threshold) {
      updateStmt.run(bestSpeakerId, 1.0 - bestDist, row.video_id, row.channel_id, row.local_speaker);
      matched++;
    }
  }
  return matched;
}

/** Compute airtime + longest-turn sample for a video-local speaker by
 *  reading the transcript markdown's per-segment data, then UPDATE the
 *  matching video_speaker_assignments row in place.
 *
 *  Used to populate stats for assignments on transcripts that were
 *  diarized BEFORE Phase 1 (where we don't have the original centroid).
 *  The transcript file is the user-visible source of truth for "how
 *  much did this speaker talk in this video," so reading it back is
 *  the most consistent answer.
 *
 *  Returns null if the queue entry has no md_path or the file lacks
 *  any segments matching `localSpeaker`. */
export function backfillVideoSpeakerMetadata(
  videoId: string, channelId: string, localSpeaker: string,
): { airtime: number; sampleStart: number | null; sampleEnd: number | null } | null {
  const entry = getQueueEntry(videoId, channelId);
  if (!entry?.md_path) return null;
  const segments = parseTranscriptSegments(entry.md_path);
  const matching = segments.filter(s => s.speaker === localSpeaker);
  if (matching.length === 0) return null;

  let airtime = 0;
  let longest = matching[0];
  for (const s of matching) {
    const dur = s.end - s.start;
    airtime += dur;
    if (dur > (longest.end - longest.start)) longest = s;
  }

  getDb().prepare(`
    UPDATE video_speaker_assignments
    SET airtime_seconds = ?, sample_start = ?, sample_end = ?, updated_at = datetime('now')
    WHERE video_id = ? AND channel_id = ? AND local_speaker = ?
  `).run(airtime, longest.start, longest.end, videoId, channelId, localSpeaker);

  return { airtime, sampleStart: longest.start, sampleEnd: longest.end };
}

/** Delete video_speaker_assignments rows whose local_speaker doesn't
 *  appear in the current transcript file. These are orphans from a
 *  previous diarization run — when the video gets re-transcribed and
 *  the new run has fewer (or different) local speakers, the old DB
 *  rows persist and pollute the "unidentified" list with phantoms
 *  that have no chip in the transcript to label.
 *
 *  Reads the transcript .md to determine which local labels are still
 *  valid. If the file is missing OR has no speaker labels at all (e.g.
 *  diarization was disabled), no rows are deleted (we'd rather keep
 *  potentially-stale rows than nuke real data on a misread).
 *
 *  Returns the number of orphan rows removed. */
export function pruneOrphanedAssignmentsForVideo(videoId: string, channelId: string): number {
  const entry = getQueueEntry(videoId, channelId);
  if (!entry?.md_path) return 0;
  const segments = parseTranscriptSegments(entry.md_path);
  const validLocals = new Set<string>();
  for (const s of segments) {
    if (s.speaker) validLocals.add(s.speaker);
  }
  // Safety: if the transcript has no labeled segments at all, skip —
  // the file might be truncated or we're misreading the format. Don't
  // delete real data on a misread.
  if (validLocals.size === 0) return 0;

  const placeholders = Array.from(validLocals, () => "?").join(",");
  const result = getDb().prepare(`
    DELETE FROM video_speaker_assignments
    WHERE video_id = ? AND channel_id = ?
      AND local_speaker NOT IN (${placeholders})
  `).run(videoId, channelId, ...Array.from(validLocals));
  return result.changes;
}

/** Bulk variant: walk every distinct video_id/channel_id with at least
 *  one assignment row, then prune orphans for each. Used to fix up
 *  pre-existing orphans from prior buggy re-transcribes. */
export function pruneAllOrphanedAssignments(): { videosScanned: number; orphansRemoved: number } {
  const rows = getDb().prepare(`
    SELECT DISTINCT video_id, channel_id
    FROM video_speaker_assignments
  `).all() as Array<{ video_id: string; channel_id: string }>;
  let orphansRemoved = 0;
  for (const r of rows) {
    orphansRemoved += pruneOrphanedAssignmentsForVideo(r.video_id, r.channel_id);
  }
  return { videosScanned: rows.length, orphansRemoved };
}

/** Bulk variant — walks every video_speaker_assignments row whose
 *  airtime_seconds is 0 (i.e. inserted as a stub by an assign action
 *  on a pre-Phase-1 transcript) and runs backfillVideoSpeakerMetadata.
 *  Cheap: just file reads + a markdown parse per row. Returns counts
 *  for the UI to surface. */
export function backfillAllZeroAirtimeAssignments(): { backfilled: number; skipped: number } {
  const rows = getDb().prepare(`
    SELECT video_id, channel_id, local_speaker
    FROM video_speaker_assignments
    WHERE airtime_seconds = 0
  `).all() as Array<{ video_id: string; channel_id: string; local_speaker: string }>;
  let backfilled = 0, skipped = 0;
  for (const row of rows) {
    const r = backfillVideoSpeakerMetadata(row.video_id, row.channel_id, row.local_speaker);
    if (r && r.airtime > 0) backfilled++; else skipped++;
  }
  return { backfilled, skipped };
}
