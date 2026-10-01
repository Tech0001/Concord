# Concord Next — Delivery 2: Speakers

Date: 2026-09-30 · Branch: `rewrite/rust-tauri` · Status: draft for review

## Why

The Electron Speakers page "was near perfect": edit, rescan, and see where each person
spoke. 0.2.0 shipped the "where they spoke" rows and speaker notes. This delivery brings
the rest of the Electron behavior across, polished, and fixes legacy defects instead of
porting them.

## What the user gets

**Speakers page**

- **Two tabs:** **Saved voices (49)** and **Unidentified (N)**. When both tabs have entries,
  there is a **Rescan unidentified** button.
- **Saved voices** are ordered by speaking time. Rows expand to show notes and appearances,
  as they do today.
- **Row actions** sit on the right as icon buttons: Find matches, Mark as noise, Edit,
  Merge, Delete. They show on row hover or focus on desktop. On phones they live in a ⋮
  menu.
- **Edit** works inline: a name field and 10 color swatches. If the new name already
  belongs to another speaker, the app explains this and offers **Merge into …** rather than
  creating a duplicate.
- **Merge** opens a dialog titled "Merge *X* into…", with a searchable speaker list and a
  confirmation that states what happens: recordings move, voice prints combine, and the
  target's name, color, and notes are kept.
- **Delete** asks for confirmation: "Recordings labelled *X* become unidentified again.
  Their voice prints are kept, so a rescan can match them later."
- **Noise** speakers sort to the end, shown muted with a "Noise" chip. They are hidden from
  Library speaker chips and the command palette, but stay listed here so they can be
  un-marked.
- **Unidentified** lists every unnamed voice across the archive, loudest first. Each row
  shows the local label, a play button (opens the recording at that voice's longest turn),
  the recording title, collection and date, speaking time, and a **Label** button.

**Label voice dialog** (from the player and the Unidentified tab)

This replaces the free-text "Name this voice" dialog.

- **Existing speaker:** a searchable list with color dots.
- **New speaker:** a name field and color swatches.
- **"Also label these as the same person"** lists the other unnamed voices in the same
  recording, with their speaking time. It is available from the player only.
- **Play a sample** plays the voice's longest turn.
- The footer has **Unlink** (when the voice is already named), **Noise**, **Cancel**, and
  **Save**.
- After saving, a toast reports the result, e.g. "Labelled as Ada · also matched in 12 other
  recordings".

**Player**

- Clicking a speaker name in the transcript or the speaker panel opens the label dialog.
- The speaker panel header shows "N unidentified · Listen", which seeks to the loudest
  unnamed voice so you can hear it before labelling.

## Matching rules (same as Electron and the current pipeline)

- **Fingerprints.** One L2-normalised TitaNet centroid per local voice, stored as
  little-endian f32 in `assignments.centroid`. Each speaker's voice print lives in
  `speakers.embedding`.
- **Match.** A match is cosine similarity ≥ **0.45**, the same threshold `speech.rs` uses,
  equivalent to Electron's distance ≤ 0.55.
- **Labelling a voice** folds its centroid into the speaker's print as a running mean,
  `(print·n + centroid)/(n+1)`, then L2-normalises it and sets `sample_count = n+1`. It then
  runs **Find matches** for that speaker. Today a print is set only when it is missing, so
  the first label wins forever.
- **Find matches (one speaker)** assigns every unidentified voice whose similarity to that
  speaker is ≥ 0.45, storing `confidence = similarity`.
- **Rescan unidentified** gives each unidentified voice its best speaker at ≥ 0.45.
- **Merge** moves assignments to the target and combines prints weighted by `sample_count`,
  then normalises. Afterwards it runs **Find matches** for the target; Electron didn't.
- **Earlier labels are never overwritten.** Matching only fills unidentified voices.
- **Unlink** clears the assignment only. The speaker's print is not recomputed, as in
  Electron.

## Data

Columns are added idempotently by checking `pragma_table_info`. **`user_version` is not
bumped**, so this can't collide with Codex's Delivery 6 schema work.

- `speakers.is_noise INTEGER NOT NULL DEFAULT 0`. On first add, any speaker named
  `(noise)` is marked as noise. That is the imported Electron noise bucket.
- `speakers.sample_count INTEGER NOT NULL DEFAULT 1`. On first add it is seeded from the
  number of assignments with a centroid, minimum 1.
- Deleting a speaker clears `assignments.speaker_id` first, because there is no `ON DELETE`
  rule.

## Out of scope

- Search filters by speaker (Delivery 4).
- Document authorship.
- Speaker label carry-over across re-transcription (Codex, Delivery 6).
- Re-embedding voices.

## Testing

- **Rust:** cosine/running-mean math; each operation on a fixture database (find matches,
  rescan, label with extra voices, unlink, noise bucket creation, merge weighting and
  notes, delete, rename collision); noise excluded from Library chips and the palette; the
  columns migration is idempotent.
- **TypeScript:** pure filtering and sorting helpers.
- **Mock host:** screenshots at four sizes in dark and light, plus CDP probes for the
  dialogs.
- **Real window:** a review build against a library copy, then the installed build.
