# Extract Audio — design

**Date:** 2026-08-06
**Status:** approved

## Purpose

A small utility page for pulling the audio track out of any video file on
the server's disk — e.g. a screen recording whose video is broken but
whose audio is fine. Not tied to the Library; works on arbitrary paths.

## UI

- New sidebar entry **"Extract"** (lucide `FileAudio` icon) in the **Ops**
  nav group; route `/extract`; page `client/src/pages/Extract.tsx`.
- One card:
  - **Video file** — path text input + native Browse button, reusing the
    existing `FileInput` component (`/api/dialog/pick-file`).
  - **Format** — radio: `M4A` (default; instant lossless copy when the
    source audio is AAC) or `MP3` (always re-encodes, plays anywhere).
  - **Extract audio** button with spinner while the request runs.
  - On success: output path, file size, duration, and a **Download**
    button (for phone/PWA use where the server path isn't reachable).
  - On failure: destructive toast with the server's error message
    (which includes the ffmpeg/ffprobe stderr tail).

## Server

`POST /api/tools/extract-audio` — body `{ path: string, format: "m4a" | "mp3" }`.

1. Validate `path` exists and is a regular file.
2. `ffprobe` the file; error clearly if it has no audio stream.
3. Run ffmpeg with `-vn`:
   - **m4a**: `-c:a copy` when the source audio codec is AAC (instant);
     otherwise re-encode with `-c:a aac`.
   - **mp3**: `-c:a libmp3lame -q:a 2`.
4. Output written **next to the source** (`same-dir/<stem>.<ext>`).
   If that name already exists, auto-uniquify (`<stem>-1.<ext>`, `-2`, …) —
   never overwrite.
5. Respond `{ outputPath, sizeBytes, durationSeconds, downloadToken }`.

`GET /api/tools/extract-audio/download?token=…` — serves a file produced
by this endpoint in this server session. Tokens are random ids held in an
in-memory `Map<token, path>`; unknown token → 404. This avoids exposing an
arbitrary-path download endpoint.

Errors follow the clip-exporter pattern: non-zero ffmpeg exit → 500 with
the stderr tail in `error`.

## Error handling

- Missing/non-file path → 400 with message.
- No audio stream → 400 "This file has no audio track."
- ffmpeg failure → 500 with stderr tail.
- Request is synchronous; the client shows a spinner. Stream-copy is ~1s;
  an hour-long mp3 re-encode is ~1–2 min, acceptable without a job queue.

## Out of scope (YAGNI)

- No extraction history / job list.
- No auto-import into the Library or transcription pipeline (drop the
  output into a watched folder if wanted).
- No batch mode, no time-range trimming (the Clips exporter covers that
  for Library items).

## Testing

- Unit-testable helper for output-name uniquification.
- Manual: extract from an AAC-audio mp4 (copy path), a non-AAC video
  (re-encode path), an audio-less video (400), and a nonexistent path
  (400). Verify Download works from another device.
