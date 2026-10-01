# Whole-branch review: Concord Next 0.2.0 (Delivery 1), f147a9b..b77bf90

Independent review run after 0.2.0 was installed. **Verdict: ready with fixes.** The backend
is solid and the architecture sound, but the player core is broken in the real app's normal
load order. Fix 1 and 2 first, then verify in the real WebKitGTK window: playback, resume,
range play/loop, and exports.

## Critical

1. **Media listeners are never attached when `media_file` resolves before `recording`.** This is
   the normal order in the real app, and the root cause of the user's "playback is wonky".
   - **Where:** `desktop/src/player/useMedia.ts:41`/`:81` (`if (!el || !src) return;`, deps
     `[ref, time, src]`), together with `PlayerPage.tsx:140`/`:326`.
   - **Why it breaks:** `useMedia` runs before the `if (!data)` early return. When `source`
     arrives first, the effect runs while `mediaRef.current` is null. When `data` arrives and
     the media element mounts, the deps haven't changed, so the effect never re-runs.
   - **Why it's the normal order:** `recording` parses 3–4.4 MB transcript JSON, while
     `media_file` is one query.
   - **What breaks:** audio plays, but the play button never flips, the clock and playhead are
     frozen, and the duration isn't updated. Resume, pause/10 s saves, transcript follow and
     current-line highlighting, range play/loop stopping, I/O times, and stored rate/volume
     are all dead.
   - **Fix:** hold the element in state via a callback ref and key the effect on it, or mount
     the media element independently of `data`.
   - **Test:** add a CDP regression probe in which the mock delays `recording`. Make mock
     latency per command configurable or randomized.

## Important

2. **Leaving the player before media is ready wipes the resume position.**
   - **Where:** `PlayerPage.tsx:62` `useEffect(() => () => save(), [save])` saves `time.get()`,
     which is `at ?? 0` until media loads. Together with 1, every open and close writes
     `position = 0`. StrictMode in dev also triggers it.
   - **Fix:** save on unmount/pause only after the media has been `ready` at least once.
3. **Opening the current recording at a new time does nothing, and "Open source" in the note
   editor discards the draft.**
   - **Where:** `App.tsx:88` (`pageKey` ignores `at`); `PlayerPage.tsx:90`/`:143` read `at` once
     per id; `NoteEditor.tsx:32-36`.
   - **Fix:** seek when `at` changes for the same id. Keep or save the draft on Open source, or
     add a real "Play range" chip. The Task 11 ruling that leaned on this is wrong.
4. **Export file names are bounded by code points, not bytes.**
   - **Where:** `format.ts:62` `slice(0,120)`. 120 emoji are 480 bytes, while Linux NAME_MAX is
     255 bytes, and `export.rs:213` adds 9 more for `.`/`.partial`. A 90-character Japanese
     title fails with "File name too long (os error 36)".
   - **Fix:** truncate by UTF-8 bytes (about 150) on a code point boundary, and use a short
     fixed partial name (`.concord-export-<uuid>.partial`, as `waveform.rs` does).

## Minor

5. **The last line can fail to copy or export.** `export.rs:110` validates against the DB
   duration + 0.5 s while the UI clamps to the media duration. Clamp in Rust instead of
   rejecting small overshoots.
6. **Search reverts query changes made from outside it.** `SearchPage.tsx:34-44`: a stale local
   `text` re-navigates 250 ms later. This affects the palette's "Search transcripts for…", the
   Search tab, and Back/Forward.
7. **The palette's mode toggle reverts the theme chosen in Settings.** `CommandPalette.tsx:18`/`:53`
   hold a separate `useAppearance` state from launch. Share one appearance state.
8. **Show in folder breaks on commas.** `system.rs:21`: `dbus-send array:string:` splits on
   commas, and `Url::from_file_path` doesn't encode them. Replace `,` with `%2C`.
9. **No range bar or export for recordings without a transcript.** `Transcript.tsx:167` returns
   the empty state without its header and footer, although I/O still draw a band.
10. **Partial files can be left behind.** At `export.rs:219-220`/`:326`, a failed `write`/`rename`
    leaves `.X.partial`. There is also no guard against a destination that resolves to the
    source media file.
11. **Exports name unnamed voices "S0"** (`export.rs:137`) while the UI shows "Speaker 1". Match
    the UI's `voiceLabel`.
12. **Accessibility:**
    - `Dialog.tsx:24` always passes `aria-describedby={undefined}`, which overrides Radix, so
      descriptions are never announced.
    - `Timeline.tsx:77-78` `aria-valuenow` is stale.
    - Arrow-key shortcuts fire on a focused volume slider or segmented radio
      (`shortcuts.ts:27` treats `range` as not typing).
    - The library list header `role="row"` is outside `role="table"` and has no column-header
      roles.
13. **Clicking a timestamp is ignored while text is selected.** `useLineSelection.ts:62`: button
    clicks don't collapse the selection.
14. **Robustness:**
    - A poisoned export mutex makes "Another export is still running" permanent
      (`lib.rs:287`).
    - The `xdg-open` child (`system.rs:32`) and ffmpeg after a waveform read error
      (`waveform.rs:53`) are never reaped.
    - A failed migration panics at launch (`lib.rs:341`/`346`) instead of showing an error.
15. **Performance:**
    - `setJobs(data)` (`App.tsx:70`) replaces the context on every poll, re-rendering the player
      every 1.5–5 s. Compare the job signature before setting state.
    - Timeline pointer moves are handled twice.
    - Library card/row `memo` is defeated by new closures each render.
    - The find effect jumps back to the first match on every data refresh.
16. **Kind is decided by file extension**, so an audio-only `.webm` gets a video stage and
    defaults to MP4 export, which Rust then rejects.

## Strengths confirmed

- **SQL:** only constant or whitelisted fragments are interpolated; all user values are bound.
- **Migration:** idempotent under concurrency, including 0.1 resetting `user_version`.
- **ffmpeg:** argv only, the stderr drain avoids deadlock, and partial cleanup on
  failure/cancel works.
- **Transcript rendering:** memoization keeps thousands of rows cheap.
- **Shortcuts:** guarded against typing, open dialogs, and keys owned by focused controls.
- **Capabilities:** minimal; only `dialog:allow-save` was added.
- **Clipboard:** works in WebKitGTK (wry enables `javascript_can_access_clipboard`).

## Not judged

- Visual polish.
- Real WebKitGTK behavior of Radix menus, fullscreen, and the GTK save dialog.
- `ShowItems` with the user's file manager.
- `pnpm install --frozen-lockfile` against the hand-mirrored lockfile entries.
- Markdown renderer performance near 20 MB.
- `format.test.ts:70` uses a real creator's name from the user's archive ("Ellen
  McFarlane"); consider a neutral name.
