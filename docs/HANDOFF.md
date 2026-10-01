# Concord development handoff

Updated October 1, 2026. Code baseline: `rewrite/rust-tauri`, **Concord Next 0.21.1**
(preview in development; full Electron port remains in progress).

The working Electron application has been moved onto the tested Nemotron speech
stack and preserved on its own branch. The Linux-first Rust/Tauri rebuild is
installed beside it as **Concord Next**. Delivery 1 rebuilt the interface on a
themeable, phone-ready design system and restored the player's range tools
(select, loop, copy, export, save as note). It is still a preview, not full parity
with the Electron app; see the delivery plan below.

## Fresh-library onboarding (0.21.1 installed)

The user tested a blank database and found that the welcome screen led with Electron import.
It now leads with **Start a new library**, followed by a separate, secondary **Import existing
library…** section. Start records `library.started` in this library's SQLite settings and opens
the ordinary empty Library view, with an Add recordings action. It does not reset data, import
anything, open a file picker, or require a first recording. The choice persists while the library
is empty, including after restart, and does not carry over to another fresh data root. Existing
archives and imported libraries continue directly to Library. Import also remains in Settings.

No schema change (still 12). Validation includes a focused Rust test for persistence, root
isolation, no import and preservation of existing notes; Clippy/frontend build; desktop/phone
screens; and native WebKitGTK fresh → start → restart → second-fresh-library checks. Reproduce
with `desktop/scripts/native-welcome-test.py`. Native roots:
`/tmp/concord-welcome-native-7iajcwy_` (start/restart) and `/tmp/concord-welcome-other-1wzddvdw`
(second fresh library). Combined report: `/tmp/concord-0211-native-welcome.log`.
Screens: `/tmp/concord-0211-screens`.

Installed and launched 0.21.1. The user is currently testing an empty default library
(`~/.local/share/concord-next/`, zero recordings); do not automatically repopulate it.
Its first-run choice is left for the user. Backup before installation:
`~/.local/share/concord-next/backups/before-0.21.1-20261001-083349.db`.

The full-port gaps listed under 0.21.0 remain the next work; this patch only addresses onboarding.

## Optional AI after transcription and date-filter layout (0.21.0 installed)

Pipeline → Setup → After transcription offers independent opt-in semantic indexing and summaries.
Both default off. Enabling binds each action to the displayed provider kind, endpoint, model and
ChatGPT account; no credentials go into SQLite. Only future successful processing completions
queue work, in the same completion transaction. A failed optional enqueue is isolated by a savepoint
and cannot roll back speech success. Existing archive recordings are not silently backfilled.

A separate worker dispatches targeted recording jobs through the existing cancellable index and
summary machinery. Speech processing continues independently. Jobs wait behind manual AI work,
retain progress across navigation, and have their own Stop/Retry/history in Pipeline. Provider or
model changes block pending work for review; saving a new choice approves future recordings only,
with explicit retry needed for blocked jobs. Disabled actions cancel pending automatic work and
stop only their own active child, never an unrelated manual job. In-flight embedding HTTP requests
finish before cancellation takes effect. Saved summaries and newer transcript revisions are skipped.

Schema 12 adds ai_followups. Child creation and queue attachment are atomic; restart preserves
queued work but does not replay interrupted requests automatically. Speech history may be cleared
without deleting pending AI work. Backup validation accepts schema 12. Application shutdown closes
the automatic dispatcher before cancelling AI workers.

The user's Search layout fix is included: From and To share a dedicated row below the four
source/collection/speaker/tag filters. The pair stays together at desktop, compact and phone widths,
including semantic-search filters which share this component.

Validation: 121 Rust tests, 48 TS tests, Clippy, frontend build, and real WebKitGTK checks for opt-in
setup, separate providers, automatic dispatch, cancellation before a summary's first token, retry
without retranscription, publication of a one-recording index/summary, and the date-row geometry.
Native report: `/tmp/concord-health-native-g_hszy_x/native-test-result.json`; reproduce with
`desktop/scripts/native-automation-test.py`. Tests use a synthetic loopback provider and scratch
library. Native completion is seeded; the actual speech-completion enqueue is covered by Rust tests.
No real archive embeddings, summaries, or remote requests were started. Screens: `/tmp/concord-021-screens`.

0.21.0 is installed beside Electron. Database schema 12 retains all 2,020 recordings; automatic AI remains off.
Backup: `~/.local/share/concord-next/backups/before-0.21.0-20261001-081207.db`.

The final parity pass has identified remaining behavior in Electron that needs specific follow-up:
- Settings.tsx `SummariesCard`: explicit batch summary backfill/overwrite (current Rust supports
  individual summaries and future automatic jobs, but not archive-wide summary generation yet).
- Pipeline.tsx single-video URL lookup/download: a direct paste-URL path without creating a source
  or requiring a YouTube Data API key. Current Rust supports video URLs as sources and Discover queueing.
- Settings.tsx `transcriptDir` and `processing.keepAudio`: configurable transcript destination and
  optionally retaining extracted audio alongside downloads. Rust currently keeps versioned transcripts
  in its managed data folder and offers manual audio extraction.
- Electron optional LAN browser access (phone/tablet on the same Wi-Fi) has no Rust equivalent yet.
  The new loopback server serves only approved media; it is not a network UI/API server.

Notes hierarchical tag rename/merge is confirmed present (including child tags) with collision tests.

Next: address these feature gaps, continue the source-by-source audit, and validate independent
installation/packaging. Platform expansion follows Linux. Do not call full parity complete.

## ChatGPT account connection (0.20.0 installed)

Settings → AI providers → Chat model now offers ChatGPT. Continue with ChatGPT opens the
system browser; a local 127.0.0.1 callback is bound first, with fresh state/nonce/PKCE. Dynamic
registration retains the issued client ID and a stable host UUID. Existing account sign-in
reuses that registration; a consumed authorization code retries using its issued client ID.
Identity signatures, issuer, audience, expiry, nonce and subject are checked against OpenAI's
published signing keys. Missing plan permission preserves sign-in but disables ChatGPT inference.
No Codex credential files or private ChatGPT backend endpoints are used.

Saved account registrations have separate labels/tokens; the selected account belongs to the
chat provider configuration. Tokens remain in atomically written 0600 chatgpt-auth.json, outside
IPC/database/browser storage, and rotating refreshes use a cross-process file lock. Failed or
cancelled sign-in retains prior working accounts. Sign-out stops requests, clears local tokens,
and attempts session revocation; an unconfirmed revocation is reported. First-use confirmation,
account model catalog, reauthorization, Manage usage links and disabled-chat status are present.
Embeddings remain independent and cannot use ChatGPT credentials or its inference route.

Chat, summaries and tag suggestions use public /v1/responses with store=false and stream=true,
full bounded input history and developer instructions. Completion requires response.completed;
failures, incomplete output and disconnections preserve prior summaries. Usage-limit errors point
to Manage usage. No silent provider/billing substitution. Account sign-out also interrupts requests
that are waiting for their first token. Status & Health reflects a signed-out ChatGPT provider.

Validation: 114 Rust tests (113 full suite plus registration retry), 48 TS tests, Clippy and
frontend build. Native WebKitGTK passed sign-in, welcome dismissal, model selection, connection
test, real streamed chat, cancellation, revocation, sign-out disabling Chat, and reauthorization
without duplicate account/onboarding. It caught and fixed a UI race when reconnecting the same
account; attempts now have their own IDs. Stopping semantic indexing leaves sign-in untouched.
Final native report: `/tmp/concord-health-native-kjscdokg/native-test-result.json`.
Reproduce with `desktop/scripts/native-chatgpt-test.py` after a native-review debug build.
All OAuth and inference tests use a loopback synthetic service and explicitly public test-only
RSA fixtures; no real account was authorized and no archive text was sent to OpenAI. Actual
account eligibility and production authorization remain user-initiated checks. Layouts checked
at desktop/phone widths in `/tmp/concord-020-screens`.

Official protocol references: [registration](https://developers.openai.com/siwc/token-sharing-open-source/sign-in),
[account sessions](https://developers.openai.com/siwc/token-sharing-open-source/profiles-and-sessions),
[Responses inference](https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference).
Remaining: optional post-transcription AI actions, final Electron parity/installation checks,
and platform expansion. Schema 11 is unchanged.

0.20.0 is installed beside Electron. Backup:
`~/.local/share/concord-next/backups/before-0.20.0-20261001-022021.db`.

## Local voice transcript preview and Markdown fence fix (0.19.0 installed)

Tools → Voice recorder has optional live ASR preview. Audio capture remains independent:
preview failure/cancellation never stops capture, and the captured WAV remains recoverable.
CPU or the selected GPU runs NeMo-Speech.cpp directly in bounded 10–30 second sections, without
Python or diarization during capture. Preview text is saved atomically beside the voice draft;
Stop preview releases speech processing, restarting resumes from the saved sample offset, and
stopping capture finishes the remaining tail. Drafts show the latest 30 sections and keep the
complete preview on disk. Save & transcribe still creates the final transcript and speaker labels;
partial preview is never published as the archive transcript.

New archive jobs wait while preview is active; any already-running job finishes first. Pipeline
and the global activity control explain this. Speech setup cannot replace models during preview.
Native test capture reads an explicitly provided local audio fixture only in debug builds; it
never opens the microphone. Existing microphone capture remains explicitly user-started.

Fixed a Markdown renderer hang: code fences such as `c++` were recognized as block starts but
not consumed as code blocks, creating an infinite paragraph loop. The shared parser now handles
language/info strings, tilde fences, nested shorter fences and incomplete fences, always advancing.

Validation: 108 Rust tests (107 full-suite plus setup/preview exclusion), 47 TS tests, Clippy and
frontend build. Native WebKitGTK CPU recognition used 21 seconds from a user-supplied test file
in a scratch library, checking actual text, continued capture after Stop preview, resumed offsets,
final-tail completion and restart persistence. Native Markdown rendering passed C++/tilde fences.
`/tmp/concord-health-native-pvkccxgq/native-test-result.json` records recovery; the combined report
is `/tmp/concord-live-preview-native-test.log`. Reproduce using
`desktop/scripts/native-live-preview-test.py /path/to/speech.ogg --offset 600` after a native-review
build. Desktop/phone layouts: `/tmp/concord-019-screens`.

Remaining: ChatGPT sign-in, optional post-transcription AI actions, final parity/installation
checks and platform expansion. Schema 11 remains unchanged.

0.19.0 is installed beside Electron. Backup:
`~/.local/share/concord-next/backups/before-0.19.0-20261001-014829.db`.

## Native pop-out video and transcript-gap skipping (0.18.0 installed)

Video can move into a separate resizable Tauri window, with its own seek bar, transport,
volume/speed controls and Return action. The original decoder pauses; main-window transport,
timestamp clicks, transcript following and selected-range previews control the pop-out.
It keeps playing while browsing other pages. Starting another recording pauses it first.
Returning restores position, volume, speed, mute and playing/paused state. The window close
path requests a final decoder snapshot, with a two-second close deadline if the webview stops
responding. Closing Concord's main window exits the whole app rather than leaving audio behind.
There is one pop-out at a time. Always-on-top is requested; desktop-compositor behavior varies.

Playback's loopback registry now has independent main, pop-out and recorder-preview slots.
Changing the main recording revokes only its own prior URL. Closing a pop-out revokes that slot.
Each URL still grants one exact file, with random tokens; no directory serving. File rename/
Trash/relink is blocked while a pop-out is open, preventing its source changing under playback.

The optional, initially-off Skip transcript gaps control restores Electron's gap-skipping idea
with a precise label. It skips gaps over 1.25 seconds, which can contain untranscribed speech;
it is not acoustic silence detection. Overlapping speaker intervals are merged before looking
for a gap. Pop-outs keep skipping while the main window browses elsewhere. Range previews
suspend gap skipping, and leaving a range preview stops that preview instead of continuing it
without its boundaries.

Validation: 104 Rust tests, 44 TS tests, Clippy and frontend build. Playback HTTP tests cover
independent registration and revocation. Existing player regressions pass for resume, timestamp
seeking, text ranges, range stop/loop, manual scrolling and saved position. Actual two-window
WebKitGTK tests pass opening/pausing, main transport and timestamp seeking, range playback
through a gap, gap skipping across navigation, source changes, another recording taking over,
returning and paused return, plus file-action guards:
`/tmp/concord-health-native-_lzdy82c/native-test-result.json`. Reproduce with
`desktop/scripts/native-popout-test.py`; media/audio are synthetic and no archive files are
changed. Compact/phone layouts checked in `/tmp/concord-player-018-screens`.

Remaining: live recorder transcription preview, ChatGPT sign-in, optional post-transcription
AI actions, Markdown edge cases, final parity/installation checks and platform expansion.
Watchers and Compare remain intentionally absent. The existing Markdown renderer matches the
Electron feature set; tables/footnotes/embedded HTML were also absent there, so richer syntax is
an enhancement rather than an Electron parity requirement.

0.18.0 is installed beside Electron; schema 11 remains unchanged. Backup:
`~/.local/share/concord-next/backups/before-0.18.0-20261001-012627.db`.

## Cancellable recording summaries (0.17.0 installed)

Summary generation now runs as a durable background job rather than a request owned by
one open player pane. Progress survives page navigation, duplicate starts reuse the existing
job, and one recording summary runs at a time. Stop works in the player and Status & Health,
including before the first token. Failed, cancelled or interrupted attempts retain the previous
summary; replacement and completion are published in one transaction only after checking that
the transcript and speaker names have not changed. Restart marks active jobs interrupted and
requires an explicit retry rather than silently sending text again. Provider settings are
snapshotted at start. Remote providers receive transcript text only on explicit generation.

Summary input now carries resolved speaker names and timestamps. Long recordings use section
summaries and bounded hierarchical reduction. Verbose intermediate output is split, never
silently truncated; non-shrinking output or excessive reduction rounds fail with a useful
message. Status & Health distinguishes summary requests from embedding and repair jobs.

Schema 11 adds summary job history and is accepted by backup/restore. Validation: 102 Rust
and 43 TS tests, Clippy, frontend build. Tests cover multi-stage generation, speaker names,
broken streams, deduplication, Stop before first token, Unicode reduction bounds, preservation
of prior content and restart recovery. Actual WebKitGTK passed navigation/re-entry, duplicate
requests, cancellation through Status & Health, successful replacement and saving as a note:
`/tmp/concord-health-native-nc0wm0ge/native-test-result.json`. Reproduce with
`desktop/scripts/native-summary-test.py` after a native-review debug build. All requests used
a synthetic loopback provider; no archive transcript was sent to a remote provider.

Remaining: player pop-out/gap skipping, live recorder transcription preview, ChatGPT sign-in,
optional post-transcription AI actions, richer Markdown, final parity/installation checks and
platform expansion. Watchers and Compare remain intentionally absent.

0.17.0 is installed beside Electron; schema 11 contains the same 2,020 recordings. Backup:
`~/.local/share/concord-next/backups/before-0.17.0-20261001-010204.db`.

## Manual YouTube discovery (0.16.0 installed)

Tools now includes Discover, alongside Extract and Recorder. It restores explicit YouTube
search, the five useful sort orders, Load more with the original query/cursor, title/description
phrase hints and optional local filtering, external viewing and download queueing. Each user
search/page request fetches one API page; there is no hidden multi-page polling. Repeated video
IDs are deduplicated. Known archive entries open directly. Queueing preserves the existing
Pipeline paused/running state and original category/metadata of existing recordings, and does
not create channels, subscriptions or Watchers. New results use the selected Personal/Work
category. Download/transcription still use the existing yt-dlp/Nemotron pipeline.

The independent YouTube Data API v3 key is in Settings. It lives in atomically written 0600
`youtube-api.json`, never in the database or returned by status IPC. API requests use the fixed
Google HTTPS endpoint, no redirects, bounded response size and a timeout. Network/body/quota
errors do not expose key-bearing URLs or raw error bodies. The UI labels this as online search.
Only public `i.ytimg.com` thumbnails were added to image CSP; no remote script capability added.
Saved credentials are included in private database backups. Restore accepts older backups that
lack this new configuration entry and removes the missing key rather than retaining an unknown
post-backup credential. Existing AI-provider setup remains independent. No real user key was
read from the legacy app or configured, and no real archive download was initiated.

Validation: 97 Rust tests (96 full-suite plus the added interrupted-body redaction test), 43 TS
tests, Clippy and frontend build. Tests cover private key storage/status, actual HTTP request
encoding/pagination, safe text decoding, quota/interrupted-body redaction, queue deduplication,
paused-state preservation and new/old backup restore. Native WebKitGTK passed Settings key
save/remove, search and phrase filtering, pagination retaining the submitted query, real durable
queue entries, and redacted failures against a synthetic loopback API:
`/tmp/concord-health-native-q3s3flu8/native-test-result.json`. Reproduce with
`desktop/scripts/native-discover-test.py` after the native-review debug build. Its endpoint
override exists only in debug builds when the native test script is explicitly enabled.
Desktop/phone layouts checked under `/tmp/concord-discover-screens`.

Remaining full-port work includes player pop-out/gap skipping, live recorder transcription
preview, ChatGPT sign-in, AI job progress/cancellation, richer Markdown and final installation/
parity checks. Watchers and Compare remain intentionally absent.

0.16.0 is installed beside Electron; schema 10 remains unchanged. Backup:
`~/.local/share/concord-next/backups/before-0.16.0-20261001-003944.db`.

## Media tools and recoverable voice capture (0.15.0 installed)

Tools is a single navigation destination, with Extract audio and Voice recorder tabs. Extract
is also reachable from Library/player menus with the current file preselected. It accepts local
media independently of the library, copies AAC into M4A when possible or encodes AAC/MP3, uses
the first audio stream, reports progress/results, and supports cancellation. Native file/save
pickers and Show in folder are wired. Outputs use a temporary file plus atomic no-replace
publication: existing source/output files cannot be overwritten, even by a collision during
encoding. The export mutex blocks recording file changes while extraction is active. No new
external dependencies or schema change.

Linux voice capture uses FFmpeg's PulseAudio input, including PipeWire's Pulse compatibility
server. pactl lists microphones when installed; the system-default input remains selectable.
Capture starts only on the explicit Record action. The Rust worker writes 16 kHz mono PCM
straight to a private WAV, periodically refreshing/syncing the header. A global recording
indicator returns to Tools from other pages. Stop retains a playable draft; Save adds it to
Voice notes with title, original capture date and Personal/Work category. Save & transcribe
uses the existing local pipeline. Discard is explicitly confirmed and cannot delete a saved
library recording. Drafts survive restart. A per-session journal and WAV-header repair recover
interrupted capture. Linux parent-death signaling kills the microphone process on abrupt exit;
normal close stops capture, extraction and range export. The stopped audio remains recoverable.

Validation: 92 Rust tests, 41 TS tests, Clippy and frontend build. Actual WebKitGTK extraction,
background capture across page navigation, draft audio playback, Library save/playback and
confirmed discard passed using synthetic inputs only:
`/tmp/concord-health-native-bo5hmrrk/native-test-result.json`. No microphone was opened.
A second real-app test used SIGKILL during capture, verified the capture child stopped, then
restarted and played/saved recovered WAV audio:
`/tmp/concord-health-native-k7cb_vrf/native-test-result.json`. Run native-tools-smoke.js with
prepare-health-review.py, or recorder-recovery-test.py after a debug native-review build.
Test-tone capture is debug-only and additionally requires CONCORD_NEXT_TEST_SCRIPT.
Desktop/phone screenshots checked under /tmp/concord-tools-screens.

Live ASR preview while recording is not ported yet; transcription is available after saving.
Other remaining work: Discover, player pop-out/gap skipping, ChatGPT sign-in, AI progress and
cancellation, richer Markdown, final parity/install checks and platform expansion. No changes
to the real archive's media or transcript contents were made by these tests.

0.15.0 is installed beside Electron; schema 10 is unchanged. Backup:
`~/.local/share/concord-next/backups/before-0.15.0-20261001-002434.db`.

## Recording file actions and relinking (0.14.0 installed)

Library and player menus now edit display titles, rename files, locate moved media and move
media to the Linux desktop Trash. Filenames retain their extension; display titles are edited
separately. UTF-8 filename bytes are bounded, separators/control/reserved characters rejected,
and Linux renameat2(RENAME_NOREPLACE) prevents overwriting an existing destination. Shared
physical paths are disclosed and updated together. Queued/active processing and ongoing source
checks block file changes; scan startup shares the same lock and active exports also block
file actions. File actions preserve transcripts, search passages, notes and speaker
assignments. Trashed items stay in the archive as Media removed; audits exclude their deliberately
unavailable media, and transcription is disabled until relinked.

Filesystem rename/Trash is journaled in the settings table before execution. Restart recovery
publishes completed operations or discards actions that never moved the source; ambiguous paths
remain visible as an archive-health error with details in Terminal. Recovery never moves files.
Trash uses the existing Gio/GLib stack, with no permanent-delete fallback. Relinking checks
sampled file fingerprints when available and a compatible FFprobe duration, updates all shared
paths, retains evidence and discards derived waveform/thumbnail caches. Copies are selected
explicitly; without an old fingerprint, duration alone cannot prove identical content.

Player file actions pause playback, reload the new source and restore its timestamp. Missing
media has a direct Locate media file button. A new source now clears prior decoder errors even
when the old media element has been removed, preventing a stuck error panel after relinking.

88 Rust tests and 41 TS tests pass, plus Clippy/frontend build. Native WebKitGTK passed title and
file renaming, shared-path updates, timestamp retention, actual Gio Trash and relinking/resumed
playback: /tmp/concord-health-native-eht6fnk8/native-test-result.json. The fixture used only
synthetic recordings and a private XDG Trash under ~/.cache/concord-file-review-7i_t0pru;
no real archive media was renamed, trashed or relinked. Reproduce with prepare-file-review.py
and native-file-smoke.js (set XDG_DATA_HOME from file-fixture.json). Unit tests also exercise
restart recovery and collision/fingerprint/active-queue rejection. Desktop/phone dialogs checked.
These native filesystem actions are Linux-only for now; macOS/Windows remain later targets.
No schema migration. Remaining work includes recorder/Extract/Discover, player refinements,
ChatGPT sign-in, AI job improvements, richer Markdown and final parity/installation checks.

0.14.0 is installed and starts cleanly with schema 10 and the existing archive retained.
Backup: `~/.local/share/concord-next/backups/before-0.14.0-20260930-235933.db`.

## Library views, categories and processing status (0.13.0 installed)

Restored named saved Library views (save/apply/update/delete) with search, collection, type,
transcript/review/status filters, Personal/Work, sorting and layout. Saved view pagination resets
on apply; malformed stored filters are normalized. Preferences remain in webview local storage,
matching Electron's behavior. They are not included in the database backup.

The top bar now carries Personal / Work / Both across Library, ordinary Search, semantic
retrieval/chat evidence, Docs, Notes, Map and Pipeline source/batch selection. Notes match any
of their evidence categories; standalone notes appear in both. A mixed-source note retains all
its evidence. Category is a browsing filter, not an access boundary. Map layouts remain separate
for each category; old Both layouts keep their keys. Queue controls/history and automatic
scheduling still cover the whole archive, labelled accordingly. Manual source checks respect
the selected category. Recording menus change category; new file imports inherit it and
re-imports preserve existing categories.

Library processing chips/filters derive from the latest attempt, including live-stream waits,
retries, cancellation and failed re-transcription with the previous transcript still available.
Earlier failed history cannot override a newer successful attempt. Mixed YYYYMMDD / ISO dates
now sort together. No schema migration is required.

83 Rust tests and 41 TypeScript tests pass, plus Clippy/frontend build. Native WebKitGTK checks
saved views, failed replacement status, category navigation through Search/Docs/Notes/Pipeline,
recording category changes and saved-view deletion. Fixture/result:
`/tmp/concord-health-native-pym07o4p/native-test-result.json`; scripts prepare-library-review.py
and native-library-smoke.js. Desktop and phone screenshots checked. Library file actions and
other remaining Electron features are still in progress.

0.13.0 is installed with schema 10 retained. Backup:
`~/.local/share/concord-next/backups/before-0.13.0-20260930-234200.db`.

## Search grouping and archive lookup performance (0.12.0 installed)

Ordinary Search again groups passages by recording, shows matching words and saved/unknown
speaker labels, and opens the selected timestamp. Added All words / Exact phrase matching;
semantic search remains on AI. Date filters normalize both legacy YYYYMMDD and ISO dates.
Keyword speaker filters match the assigned identity rather than accepting an overlapping
other voice. Duplicate query submission on navigation was removed. Highlight colors use the
theme. Documents/notes continue to appear as separate source results.

Schema 10 replaces the metadata-bearing FTS virtual table with indexed timed passage rows
plus an external-content FTS5 text index. Insert/update/delete triggers keep them synchronized;
row IDs and passage contents survive migration. Per-recording passage access now uses a
B-tree rather than scanning all transcript rows. This fixes repeated full-archive scans during
embedding preparation, transcript fallback reads and speaker-range lookups. It does not change
embedding models or claim equivalent gains in neural inference speed.

A copy of the real archive migrated in 9.1 seconds. All 958,117 passages and the checked media,
speaker assignments/profiles, notes/anchors, documents and links were preserved. Looking up
30 recordings took 4.81 seconds before and 0.0098 seconds afterward in the local benchmark.
Copy/results: /tmp/concord-search-archive-6ms6nz8q (benchmark-before/after.json).

79 Rust tests and 39 TS tests pass, plus Clippy and frontend build. Native WebKitGTK passes
groups/highlights/speakers, documents, compact-date filtering, exact phrases and timestamp
navigation: /tmp/concord-health-native-v358bjwa/native-test-result.json. Reproduce with
prepare-search-review.py and native-search-smoke.js. The archive-copy migration has its own
ignored integration test, requiring CONCORD_TEST_ARCHIVE_ROOT under the system temp folder.
Health fixture creation now supports both old and new segment schemas. Desktop/phone layouts
checked. Remaining port work includes library views/file actions, tools, player refinements,
account-login chat, and broader installation validation.

0.12.0 is installed; the live archive migrated to schema 10 with all 958,117 passages,
595 documents, five notes and 49 speaker profiles retained. Backup:
`~/.local/share/concord-next/backups/before-0.12.0-20260930-232645.db`.

## Independent speech installation (0.11.0 installed)

Settings now prepares speech without an Electron installation: private uv 0.12.5, managed
Python 3.12.14, hash-locked NeMo 2.7.3/PyTorch 2.13 CPU dependencies, and three pinned,
verified models (Nemotron ASR/diarization and TitaNet). uv is bundled with licenses and source
references. Model files download to the native data folder; verified old GGUFs can be copied.
Voice matching runs on CPU in new environments; native ASR/diarization still use the selected
CPU/GPU. Existing CUDA voice environments remain supported. CUDA capability is checked in
Python instead of inferred merely from nvidia-smi. Eight CPU threads prevent oversubscription.

Setup shows progress, cancellation, errors and logs. A new environment activates atomically
only after extracting a finite 192-dimensional fingerprint. Failed/cancelled installs retain
working models/environments and transcripts. Interrupted setup offers retry; verified models
are reused. Queue work is held while setup is active and resumes afterward. FFmpeg is checked
before setup; AppImage users still install it with their distro package manager. The .deb
already declares it. No live-library speech environment was replaced during these tests.

77 Rust tests, 38 TS tests, three Python adapter tests, Clippy and the frontend build pass.
A fresh isolated private install and GPU-ASR/CPU-voice recording passed in 70 seconds total:
`/tmp/concord-speech-setup-4KnnBd`. A separate entirely CPU-based 25-second recording passed in
23 seconds. Native WebKitGTK checks private paths/readiness and cancelling a repair while
retaining the active environment and transcript; native-test-result.json in the same folder
passes. Desktop and phone screenshots checked. ARM dependency locks resolve but have not
been exercised on ARM hardware. Public installation validation and full Electron parity
remain in progress. README now documents current functionality and setup instead of the
obsolete first-preview requirements. 0.11.0 is installed; bundled uv and GPU discovery
work from its actual AppImage resources. Backup:
`~/.local/share/concord-next/backups/before-0.11.0-20260930-231002.db`.

## Subscriptions and download setup (0.10.0 installed)

Pipeline now separates Queue, Transcribe recordings, Sources, and Setup. Sources support
YouTube channels/playlists/videos and local folders, enable/disable, rename/category changes,
per-source diarization and Shorts, recent checks or full-history discovery. Removing a source
keeps existing recordings, research and files. Rechecks deduplicate across tabs and sources.
Folders never recursively follow symlinks; overlapping roots are rejected.

Setup includes destination, quality/codec/audio preferences, audio-only downloads, speech
language, retry policy, schedule, daily cap, rate/pacing and optional browser/file cookies.
Automatic checks remain OFF after upgrading; Start/Pause controls scheduling. Live streams
wait until a recording is available. Daily allowance resets at local midnight; waiting downloads
do not block local transcription. Interrupted work survives restart. Files completed before
an ASR failure are retained and reused, without a second download or daily count. Existing
transcripts stay readable throughout retries. Media status follows active work without an
old cancelled-history row overriding a newer failure.

Schema 9 extends channel metadata and pipeline work, and records successful daily downloads.
The old download folder/quality/codec/pace/limits are imported once, without enabling downloads
or importing cookies. yt-dlp 2026.08.19 and Node 24.21.0 are privately bundled from pinned,
SHA-256 verified official artifacts; licenses and source references ship alongside them.
No remote JS components are installed during downloads. FFmpeg remains a host dependency,
now included in download readiness checks. AppImage Python/library paths are cleared for
these host/private helper tools.

74 Rust tests and 38 TypeScript tests pass, along with Clippy and the frontend build. Native
WebKitGTK verifies source setup/edit/removal, folder discovery, categories/diarization flags,
idempotent scans, mocked YouTube subprocess listings, real subprocess file publication and
retention after intentional missing-model failures. Fixture: prepare-subscriptions-review.py
and native-subscriptions-smoke.js. Latest result: /tmp/concord-health-native-h1xqpyvn.
Bundled yt-dlp and private Node also downloaded a public YouTube test video; FFmpeg merged
its AV1 video and Opus audio into a valid 596-second MP4. A real 25-second GPU
transcription-only job passed with words and no speaker assignments. The installed AppImage
starts both bundled tool versions successfully. Schema 9 retains all 595 documents and has
an empty processing queue. Backup:
`~/.local/share/concord-next/backups/before-0.10.0-20260930-225007.db`.
Desktop/phone Sources and Setup layouts checked. No live-library source scan or download was
started. Independent speech installation and the remaining Electron parity are still pending.

## Durable processing queue and batch transcription (0.9.0 installed)

Pipeline now has Queue, Transcribe recordings, and Setup. Select individual recordings,
a collection, missing transcripts, or all matches. Batch enqueue is initially paused; Start
runs one recording at a time. Pause finishes the active recording; Stop cancels it and pauses
the rest. Cancel individual/pending items, retry failed items, and clear finished history.
Settings save retry count/delay and processing device. Queues, delayed retries and run/pause
state survive restart; interrupted attempts do not consume a retry. There is no automatic
whole-archive enqueue or subscription download. Player/Library transcription joins this queue.
Status & Health links to Pipeline and shows processing/queued/retry/failure counts.

Schema 8 adds pipeline_work, tied to existing jobs with cascading history deletion and a
unique active-job constraint per recording. Old transcripts remain published until success.
Manual labels carry across changed diarization IDs using clear voice-fingerprint or timeline
matches; ambiguous changes remain available for speaker review. Reused local voice numbers
no longer reuse the old fingerprint training ledger. Failure rolls the transcript/label
transaction back. Model numbering is never used as an identity match.

68 Rust tests, 38 TypeScript tests, Clippy and frontend build pass. Native WebKitGTK fixture
checks setup, batch filtering/selection, paused enqueue, real worker failure retaining old
transcript/manual labels, pause/retry/cancel and history clearing. Reproduce with
prepare-health-review.py + native-pipeline-smoke.js and CONCORD_NEMO_MODELS set to a missing
scratch directory (intentional dependency failure). Result: /tmp/concord-health-native-ja3_fe7u.
A real 25-second GPU transcription through the new worker passed in 23 seconds, published
only inside a temporary library and released its processing lock. Desktop/phone layouts checked.

0.9.0 is installed with schema 8 and an empty processing queue. Backup:
`~/.local/share/concord-next/backups/before-0.9.0-20260930-221345.db`. Next: sources/subscriptions, downloads and their
setup/scheduling/daily limits, followed by remaining Electron parity. The full port remains
in progress. Pipeline setup does not yet install the speech runtime independently of Electron.

## Docs folders and live sync (0.8.0 installed)

Restored the document folder tree beside the independently scrolling reader, multi-root
add/rename/pause/remove controls, filtering across folders, stars and Personal/Work categories,
local images, relative Markdown links, author-to-speaker navigation, and linked research notes.
File changes are scanned locally every 10 seconds; the open reader refreshes automatically.
No AI requests occur during folder sync. The explicit semantic-index button uses the separately
configured embedding provider. Unchanged text keeps its vectors; changed text invalidates them.
Document IDs, stars, categories and note anchors survive edits and disconnected files/folders.
Removing a folder stops syncing and retains cached documents/evidence; source files are untouched.

Schema 7 adds sync metadata and folder labels. Older Electron documents with NULL root_id
belong to its first folder (empty ID). The earlier importer missed these 295 paths; a guarded
read-only recovery restores them without changing edited metadata or detached folders.
A real-archive scratch sync kept exactly 595 documents across two roots, no duplicates or
errors, with categories, stars, IDs and all research anchors intact. Local asset/link resolution
rejects paths outside the document's folder and does not follow directory symlinks during scans.

Native WebKitGTK tests pass root setup, nested tree, local image, author matching/navigation,
relative document links, star/category updates, selection-to-note, live file change reflected in
the reader, filters and folder removal retaining evidence. Fixture scripts:
`prepare-documents-review.py`, `prepare-documents-review.py --watch <scratch>` (synthetic edit),
and `native-documents-smoke.js`. 61 Rust tests and 38 TS tests, Clippy and frontend build pass.
Desktop and phone reader screenshots checked. 0.8.0 is installed; live schema 7 retains all
595 documents (300 Personal / 295 Work), five notes and six anchors. Backup:
`~/.local/share/concord-next/backups/before-0.8.0-20260930-215326.db`.
Next: Pipeline setup, subscriptions/downloads, durable queues and batch re-transcription,
then remaining Electron parity (including tools and library/player improvements).

## Status, Health, and Terminal correction (0.6.0 installed)

The user supplied Electron Status/Health/Terminal/Map/Docs screenshots and clarified
that the small activity/runtime drawer was an incomplete port. Status & Health now
opens a wide workspace with Status, Health & repair, Activity, and Terminal tabs.
Implemented: archive totals and coverage, channel rollups, local audits with affected-item
review, transcript reindexing, thumbnail generation, scoped embedding repairs, sampled
media fingerprints and duplicate review, durable repair jobs with cancel/resume, embedding
width verification, and recoverable database backup/restore. Backups include private provider
configuration and use mode 0600. Restores are validated, explicitly staged through a product
confirmation, applied at restart, and retain the previous library as a separate backup.
Terminal is read-only runtime output with filter/pause/follow/copy/clear; the earlier removal
request concerned themes, not this feature.

Schema 6 adds maintenance/index provenance, fingerprints, channel metadata, and document
root/path/category metadata. A one-time **read-only** legacy metadata import recovers old
summaries, channel settings, document categories/root paths, and transcript index timestamps,
without replacing edited notes, speaker labels, or new transcripts. A real-archive scratch
check recovered 1,975 summaries and all document categories. Corrections made afterward:
missing-transcript completed items retain completed status; existing legacy artwork counts
as cached; diarization coverage counts distinct eligible recordings (never >100%).

Native scratch UI checks passed dashboard, audit/review, reindex preserving speaker labels,
fingerprints, backup validation/staging/cancellation, and live log buffering/filtering/clear.
Unit tests cover backup round-trip and retained pre-restore data, invalid backups, duplicate
fingerprint invalidation, safe reindexing, and atomic connection edits. CSS loading was caught
in screenshots as a stale Vite cache; restarting Vite fixed it. Native computed styles and corrected real-archive counts passed. **0.6.0 is installed**,
with schema 6 and 1,975 recovered summaries confirmed in the running library. Backup:
`~/.local/share/concord-next/backups/before-0.6.0-20260930-210115.db`.
52 Rust tests, 34 TypeScript tests, seven player regressions and Clippy pass. A real-archive
scratch audit and 218 MB backup passed; it matches the old two missing transcripts, 25
stale indexes, and one missing thumbnail. Native semantic vectors require first indexing
for the new model, so their missing counts differ from Electron. Reproduce the UI check
with `prepare-health-review.py` and `native-health-smoke.js`.

The user asked why an amber stripe appeared inside a cyan speaker section. It was the
current-playback highlight, not another speaker. The source now uses the speaker's own
color for the current line plus a small play marker beside its timestamp.

## Map and extended research import (0.7.0)

The native Map now has Videos, Cards, Arc, and Cluster layouts, search/collection/tag filters,
passage-level drag-to-connect handles, typed edge editing/reconnection, explanations, resizable
nodes, saved positions/dimensions per view, a note inspector, source navigation, pan/zoom and
minimap. Whole-note links remain distinct from passage links. Shared-tag and same-recording
connections are optional computed overlays; they are never saved as user-authored links.

An idempotent read-only Electron importer recovers multi-source note evidence, tags, detailed
connections and saved layouts omitted by the earliest preview. It upgrades only untouched
notes and an unchanged imported graph, preserving native edits and positions. Missing sources
never erase already-imported evidence. Fresh legacy imports also run this recovery immediately.
A real-archive scratch check recovered all five notes, six passages, five deduplicated typed
links and 12 applicable saved positions; all five edges rendered in native WebKitGTK.

Native scratch UI checks pass multi-recording groups, document/standalone notes, selecting a
non-first row, dragging passage handles to create a connection, atomic edge editing, persisted
node dragging, all four layouts, and search/tag filters. Reproduce with
`prepare-health-review.py` and `native-map-smoke.js`. 55 Rust tests, 37 TypeScript tests,
Clippy and frontend compilation pass. Desktop and phone screenshots checked.
0.7.0 is installed and running; live library recovery confirmed (five notes, six anchors, five links).
Backup: `~/.local/share/concord-next/backups/before-0.7.0-20260930-213212.db`.
Next: Docs folder tree/live sync, Pipeline, and remaining parity. Full port is not complete.

Follow-up fixes included before installing 0.7.0: Status & Health keeps the title/tabs outside
its clipped scroll area (the user saw content leaking above the tabs). A native WebKitGTK
check confirms the header stays fixed while content scrolls. Speech runtime probing and the
Python coordinator now isolate LD_LIBRARY_PATH to the private NeMo folder, in addition to
clearing AppImage PYTHONHOME/PYTHONPATH. The AppImage's WebKit libraries had caused NeMo's
GPU/backend discovery to fail; the UI misleadingly said CPU and Setup needed. The actual
RTX 2080 Ti is detected with Vulkan and CUDA voice matching works. Doctor's valid CPU report
is accepted even when it exits 1 for absent GPU drivers, preserving CPU-only support.
Settings explicitly says Selected processing and exposes runtime errors separately. A real
25-second speech job passed using the installed AppImage's environment and speech binary.


## Current direction and 0.5.0 work (September 30, late evening)

The user reiterated full parity without stopping for approval, and refined navigation:
Library, ordinary word Search, Notes, Docs, Speakers, AI, Map, Pipeline, Settings.
**AI has Semantic search and Chat tabs.** Semantic search is available by default with
an app-managed local embedding model; Chat is disabled until a provider is configured.
The user does not want semantic search in ordinary Search. Keep embedding/chat settings
independent. Status and Health share one diagnostics panel. Extract belongs in Tools and
recording actions. Compare remains omitted pending a concrete use case. These latest
choices override the old combined words/meaning/chat design below.

0.5.0 is packaged and installed beside Electron. The installed app runs schema 5.
Backup: `~/.local/share/concord-next/backups/before-0.5.0-20260930-202621.db`.
The already-downloaded embedding GGUF was SHA-256 verified and copied into the native
model directory; no full-archive indexing or remote AI request was started.

Implemented in 0.5.0:
- Built-in Qwen3-Embedding-0.6B Q8 (639,150,592 bytes), pinned SHA-256 and HF revision,
  downloaded on first Prepare semantic search. App-managed llama.cpp CPU runtime;
  no Python, separate AI app, key or dedicated GPU needed. External embedding providers
  are optional. Runtime uses a private loopback endpoint and ends with the app.
- Separate local/OpenRouter/custom providers, model pickers, keys and connection tests.
  Credentials are atomically saved mode 0600 outside the SQLite DB and redacted from IPC.
  Endpoint changes clear an old credential. No actual remote provider was called in tests.
- Durable/resumable model-specific embedding indexes; source edits invalidate vectors.
  Search filters for source type, collection, speaker, date and tags. Schema 5.
- Separate AI page, streamed chat with citation snapshots, conversations, pin/rename/delete,
  starred messages, answer-to-note, transcript summaries and AI tag suggestions.
- Status & Health combines activity history, speech checks, indexing and diagnostics.
- Transcript speaker turns have soft colored bubbles, grouped by saved identity across
  fingerprints. Unknown turns have a visible Name speaker action opening the full mapping
  dialog (existing person, new person, same-person locals, noise/unlink/sample).
- User requested removal of Terminal, Amber Terminal and Altar Invert themes, explicitly
  **without adding fallback/migration behavior**. Only those CSS files were removed.

Verification so far: 47 Rust tests, 34 TS tests, seven player browser regressions, Clippy.
Real CPU embedding check passes: three short inputs, 1024 dimensions, ~937 MiB peak RSS,
0.36 s inference on this PC; prayer query ranks prayer over car-maintenance passage.
Native WebKitGTK/real Rust IPC tests pass independent settings, disabled chat defaults,
indexing, semantic results, streamed chat/citations, saved answer note, separate word search,
and speaker bubbles/naming/mapping multiple fingerprints to one person. Tests use scratch
libraries and a localhost synthetic AI server. Relevant scripts: native-ai-smoke.js,
mock-ai-server.py, native-speaker-bubbles.js; real model test is opt-in with
CONCORD_EMBEDDING_MODEL pointing to the pinned GGUF.

Remaining: ChatGPT sign-in is researched but **not implemented**; then Map and Pipeline,
and audit remaining Electron features (saved views/categories, recorder, Extract, Discover,
pop-out, silence skip, folder document sync, backups/runtime setup). Only Watchers and Compare
are agreed removals; the old Delivery 6 brief incorrectly calls some other features removed.
Do not stop at this increment or claim full parity.

## Notes and evidence (0.4.0)

Delivery 3 now includes multiple recording ranges and document passages per note,
adding a selected passage to an existing note, editing/removing evidence, normalized tags
and suggestions from existing tags, tag rename/merge/delete (including descendants),
typed connections with explanations, Notes filtering/sorting and detail pane, and saved
passage highlights that open the note directly from the transcript. Standalone notes are
supported. Unsaved editor changes require an explicit discard; opening a source saves first.
Schema 4 adds anchors, tags, link metadata and map positions. Stable anchor IDs survive
reordering. Removing an anchor removes only its anchor-specific links; ordinary note links
survive. Existing single-source notes are backfilled without touching their source files.

About copy corrected at the user's request: the library is local, but remote embedding
or chat providers receive the text needed for requests. Delivery 4 must expose completely
separate provider/key/model settings for embedding and chat (e.g. local embedding with
OpenRouter chat or the reverse). Do not claim that no data ever leaves the computer.

Verification: 40 Rust tests, 34 existing TypeScript tests, all seven player browser
regressions, Clippy with warnings denied, and frontend compilation passed. A real
WebKitGTK test using real Rust IPC passed transcript selection → multi-source note → tags,
editing without losing anchors, transcript highlights, typed links, tag management, and
document selection appended to an existing note. Scripts:
`prepare-native-review.py` creates a fresh test copy; `native-notes-smoke.js` exercises it.
AI-generated tag suggestions will share the chat provider in Delivery 4; existing-tag
suggestions already work without AI. Full port work remains in progress.

## Port continuation — Speakers and Activity (0.3.0)

The user authorized continuing through full Electron parity without stopping for approvals.
Keep the polished design; Watchers and Compare are the only agreed removals. Work through
Speakers, Notes, Search/AI, Map, and Pipeline, then audit the unscheduled Electron tools and
library/player/document capabilities. Do not mark the whole port done after a single delivery.

Delivery 2 implemented: saved/unidentified lists, profile rename/color/noise, merge/delete,
rescan and individual Find matches, full label dialog with existing/new profiles, additional
local voices, unlink/noise/sample controls, and grouped appearances with individual fingerprint
controls. Matching still uses cosine >= 0.45 and never overwrites existing labels. A training
ledger prevents repeated Save and unlink/relabel from counting the same fingerprint twice.
Schema 3 adds the speaker fields and ledger and backfills missing local assignments.

Activity now separates active jobs from collapsed recent history, dates each attempt, and has
Retry, per-attempt dismissal, and Clear finished. Clearing history cannot remove running or
queued jobs or recordings. The user's old Python failures were historical attempts, not new
failures after 0.2.2. The 0.2.2 Python environment fix is included.

Verification: 37 Rust tests passed (two opt-in tests excluded), 34 TypeScript tests passed,
Clippy passed with warnings denied, and frontend compilation passed. Native WebKitGTK
checks in a SQLite backup passed creation/automatic matching, grouped appearances,
rename/color, merge/noise/delete, and Activity history clearing. The native test script is
`desktop/scripts/native-speakers-smoke.js`; its fixture needs three local 2D centroids with
S0/S1 similar and S2 orthogonal, created by `python3 desktop/scripts/prepare-native-review.py /path/to/library.db`.
The original library was never used for test mutations.

## Packaged speech repair (0.2.2)

The installed AppImage exported `PYTHONHOME` and `PYTHONPATH` for its media helpers.
Those leaked into the independent speech venv, causing Python to fail during startup
with `No module named encodings`. Speech commands now remove both inherited variables.
The media framework's own environment stays intact. The poisoned-environment regression
passes, and a 25-second real recording passed ASR, diarization, and TitaNet matching using
packaged resources and the installed application's environment with those two variables
removed. The existing transcripts remain intact when a job fails.

## Codex takeover and 0.2.1 repair (September 30, 2026)

Codex owns the entire Rust implementation again. **Electron is the behavioral reference
for every page; preserve its capabilities in the polished interface.** The user explicitly
wants Pipeline and transcript range selection improved where the old workflows were
awkward. Watchers and Compare remain the agreed removals. The earlier parallel-work
ownership restrictions and per-delivery approval steps no longer apply.

**0.2.1 is built and installed** at `~/.local/opt/concord-next/Concord-Next.AppImage`.
The sidebar toggle/drawer is included. Repairs:

- Bind playback events to the mounted media element, including when the media URL arrives
  before the large transcript. Play/pause, overlay, clock, follow, and ranges now receive events.
- Preserve resume when the user leaves before media loads; honor changed timestamps on
  the same recording.
- Remove unstable estimated transcript row heights; manual interaction suspends following;
  timestamp clicks work even while text is selected. Keep Claude's selection/range design.
- Group the recording's local voices by **speaker ID**, retaining all fingerprints and
  combining airtime. Two distinct people with the same name remain distinct.
- Fix a second native playback defect found during the repair: the loopback server capped
  each range at 4 MiB, causing GStreamer to signal EOF after ~28 seconds in the regression
  recording. Send the entire requested range using streamed reads, with Content-Length.
- Enable clipboard access on the explicitly created Tauri main window. Copy failed in
  WebKitGTK after the asynchronous transcript request; the real system clipboard now
  receives the selected passage. App state is initialized before the window is created.
- Repair the review's note draft loss, search query resets, stale theme toggle, UTF-8 export
  filenames, orphan temporary exports, source overwrite guard, unnamed export labels,
  timeline accessibility, focused-control shortcuts, and unnecessary job-poll rerenders.

Regression tools added (no new dependencies):

```bash
# With the Vite dev server running:
pnpm --dir desktop test:player
# Linux PyGObject/GStreamer test against the real Rust media server:
pnpm --dir desktop test:media
```

The media regression uses a generated minute of PCM audio. Restoring the old cap makes
it fail at 51.845 seconds after a seek to 30 seconds; the corrected server decodes through
60 seconds. Existing Rust tests continue checking ffmpeg exports and database behavior.

For automated **real WebKitGTK** UI checks, a debug-only runner is enabled only when all
three environment variables are present: `CONCORD_NEXT_TEST_SCRIPT` (absolute path to
`desktop/scripts/native-player-smoke.js`), `CONCORD_NEXT_TEST_RECORDING` (recording ID),
and `CONCORD_NEXT_DATA` (**a scratch SQLite backup**, never the live library). Build with a
separate Tauri identifier (keep `create: false` if overriding the window configuration),
then launch that debug binary with these variables and the local
GStreamer plugin path. It writes `native-test-result.json` under the scratch root and exits.
The runner is absent from release builds. The script uses real media and IPC, exercises
native selection/play/loop/copy/resume, and reports any remaining OS-dialog checks.

Verified for 0.2.1:

- 34 TypeScript tests, 31 Rust tests (two opt-in tests excluded), seven browser player
  regression scenarios, the opt-in GStreamer streaming regression, and warning-free Clippy.
- Actual WebKitGTK window with the real long AV1/AAC recording: timestamp seeks,
  advancing clock/playhead, play/pause/overlay, playback past the former streaming cutoff,
  selecting text, range stop/loop, manual transcript scroll, and persisted resume.
- Native Copy succeeded; the system clipboard SHA-256 matched the exact selected text.
- The user accepted the native GTK Save dialog and confirmed the clip worked. The M4A
  export contains AAC audio and ffprobe reports **8.480 seconds**, exactly the selected
  interval. “Show in folder” completed, and the user confirmed the result was all set.
- The AppImage and Debian package built successfully. No new dependencies or schema
  migration were needed; this does not complete the remaining Electron parity deliveries.

Current scratch root: `/tmp/concord-playback-review`; SQLite backup of the native library,
original media read in place. Local diagnostic logs are under `/tmp/concord-*` and are not
repository artifacts. Production Electron data and media files are untouched.

Next: complete Speakers management and labeling against `server/db-speakers.ts` and
`client/src/pages/Speakers.tsx`, then the remaining parity deliveries below. Keep shipping
working installed increments; do not describe the rewrite as complete while parity is missing.

## Status at handoff back to Codex (September 30, 2026, evening)

Historical status from Claude before the 0.2.1 repairs above. Those repairs supersede
the playback and verification gaps in this section.

**Shipped and installed:** Concord Next **0.2.0** at `~/.local/opt/concord-next/`. The real
library migrated to `user_version` 2. Everything committed on `rewrite/rust-tauri`.

**Committed after 0.2.0, not packaged yet:**
- `2e33c7b`: a sidebar toggle beside the logo; the labelled sidebar opens as an overlay
  drawer on windows narrower than 1200px. Requested by the user.
- `49a149f`: the brief for parallel Delivery 6 work,
  `docs/superpowers/briefs/2026-09-30-codex-delivery-6.md`. Now that Codex owns everything,
  ignore its worktree and coordination rules; its scope and legacy notes still apply.
- `docs/superpowers/specs/2026-09-30-speakers-design.md`: a **draft** Delivery 2 spec.
  The user has not approved it.

**Open bug, root cause found by the final review:** "the playback is wonky" in the
installed 0.2.0. Fix Critical 1 and Important 2 in
`docs/superpowers/reviews/2026-09-30-delivery-1-review.md` first. `useMedia` never attaches its
listeners when the media URL resolves before the transcript, which is the normal order
with large transcripts. Leaving a recording then saves position 0. The hypotheses below
were written before the review and are probably secondary.

Original report: "the playback is wonky" in the installed 0.2.0 WebKitGTK window. Playback of the new player was never verified in the
real window, only in headless Chromium.

Unconfirmed hypotheses, to check with evidence before fixing:
1. `player/useMedia.ts` pushes `currentTime` into the time store on every
   `requestAnimationFrame`. `Timeline`'s `Playhead` then re-renders about 20 times a second
   and moves via `left: %`, which forces layout and paint. That is expensive with
   `WEBKIT_DISABLE_DMABUF_RENDERER=1` (software compositing on NVIDIA/Wayland, see
   `main.rs`), and could starve GStreamer. The 0.1 player used native controls with
   `timeupdate` (about 4 Hz).
2. `player/Transcript.tsx` follow-along calls `scrollIntoView({ behavior: "smooth" })` on
   every line change, with `content-visibility: auto` rows.
3. `seek(t, true)` sets `currentTime` and calls `play()` immediately; WebKitGTK may stutter
   if play is called mid-seek.

Ask the user what "wonky" means (stutter, jumps, lag on seek, desync) and watch CPU for
`WebKitWebProcess` while playing.

**Also never verified in the real window:** export through the native save dialog, "Show
in folder" (D-Bus FileManager1 with an xdg-open fallback, `system.rs`), and Copy
(`lib/clipboard.ts`, with an `execCommand` fallback).

**The final whole-branch code review** of 0.2.0 (`f147a9b..b77bf90`) is saved at
`docs/superpowers/reviews/2026-09-30-delivery-1-review.md`. None of its findings are fixed
yet.

**Useful tooling:**
- Mock host: `pnpm --dir desktop dev`, then open `http://127.0.0.1:1420/?mock`. Add
  `&theme=lifeOS`, `&mode=light`, or `&gallery`.
- Screenshot runner: `node desktop/scripts/screens.mjs <outdir> [filter]`, with env `SIZES`,
  `MODES`, `EXTRA` (JSON shots with `after`/`probe` scripts), `BASE`, and `CDP_PORT`.
  `PlayerPage` exposes `window.__concordTest` in dev for scripted range/find/export.
- Real-window review builds: `pnpm --dir desktop tauri build --no-bundle --config
  '{"identifier":"app.concord.next.review"}'`, run with `CONCORD_NEXT_DATA` pointing at a
  `sqlite3 .backup` copy of the library.

## What the user wants

Concord is a local spoken-word research archive: recordings, transcripts, speaker
identities, documents, notes, and connections between them. The rebuild should
make it easier to use, install, maintain, and present as an open-source project.

- Use Rust and Tauri. Platform order is **Linux, then macOS, then Windows**.
- Keep the improved multilingual transcription and the existing method of linking
  speakers across overlapping windows. Aim for 16-person recording capacity.
- Support CPU operation for lower-spec PCs and eventually Macs; an NVIDIA GPU
  should not be a prerequisite for native ASR and diarization.
- Remove the **Watchers** section. This does not mean removing ordinary channel
  subscriptions, imports, or background transcription.
- Make search coherent. The previous split between exact search, semantic search,
  and AI chat was confusing.
- Keep Documents and Speakers. Notes need refinement, but are used less often.
- Keep and improve the Map: the user sees it as a potential differentiator.
- Simplify channel setup and AI configuration, which had accumulated in Pipeline.
- Keep **embedding providers/models separate from chat providers/models**.
  The user wants local AI and OpenRouter options, and asked about an optional
  Codex/ChatGPT account login. That login integration is not implemented or
  validated in this preview; investigate the supported authentication path first.
- The user questioned Compare's purpose. It is absent from the new navigation;
  do not port it automatically without a useful workflow.
- Use the supplied icon assets, not the previous placeholder branding.

The user prefers concrete implementation and installed builds to try. Preserve
the working lane while developing the next one. They specifically asked that model
experiments first run with a separate database and the same proven Concord
grouping pipeline, rather than replacing several parts of the algorithm at once.

## Delivery plan (agreed September 30, 2026)

The Electron app is the reference: the user liked it and wants the same
capabilities rebuilt in Tauri and **more polished**, not reinvented. Each area
reaches Electron parity, then gets polished. Order:

1. **Foundation, polish pass, and player ranges** — shipped in 0.2.0; playback and
   range-tool repairs verified and installed in 0.2.1. Spec:
   `docs/superpowers/specs/2026-09-30-next-foundation-polish-design.md`; plan:
   `docs/superpowers/plans/2026-09-30-next-foundation-polish.md`.
2. **Speakers** — implemented in 0.3.0: edit, recolor, merge, noise,
   rescan/find matches, unidentified queue, the full label dialog. Appearances
   ("where they spoke") and speaker notes are included. Schema 3 includes
   `speakers.is_noise`, `sample_count`, and the training ledger.
3. **Notes** — implemented in 0.4.0: multi-anchor notes (ranges and document passages),
   tags, typed links, a real Notes page, and range notes from the player.
4. **Search and AI** — ordinary Search stays separate. AI contains Semantic search and
   Chat tabs; embeddings default to a built-in local model, while chat requires configuration.
   Embedding and chat providers/models/credentials are independent. See 0.5.0 status above.
5. **Map** — Electron parity, then better (explicit user control, persisted layouts).
6. **Channels and pipeline** — subscriptions, downloads, a durable batch
   re-transcription queue. No Watchers.

Decisions from the user: range selection is line-level, not word-level. Every
screen must work on a phone (the UI is ready; serving it to a phone is a later
decision). Legacy data top-up/sync is deferred, because the whole archive will be
re-transcribed on the new engine; add schema fields fresh as features need them.
The user prefers building over long planning and few questions.

## Branches and completed stages

| Branch | Code checkpoint | Purpose |
| --- | --- | --- |
| `main` | `dcf1fe5`, tag `v2.4.4` | Original baseline before these experiments |
| `experiment/nemotron-diarization` | `26a73df` | Isolated diarization and ASR comparisons |
| `feature/nemo-native` | `856337f` | Working existing UI with native multilingual Nemotron ASR and diarization; parked for continued use |
| `rewrite/rust-tauri` | `c65bcce`, then `8b1e271` | Native desktop foundation, followed by resizable video/transcript panes |

These are local checkpoints. This work has not been pushed or published.
The installed original Concord remains available; do not overwrite it when
installing Next. Legacy source remains in the rewrite branch for migration and
because the speech coordinator is still reused.

The early isolated tests initially tried alternative speaker grouping. Those
results are historical, not the final replacement strategy. At the user's
direction, we reran Nemotron through Concord's existing diarization pipeline.
Then we compared actual transcription models and selected Nemotron 3.5
multilingual after the user reviewed the difficult October 7 passage and found
it substantially better than Parakeet.

Some experiment reports end with cautious recommendations made **before** that
review and integration. Preserve their measurements, but use the later branch
decision as the current product direction.

## Speech stack and evidence

| Responsibility | Current implementation |
| --- | --- |
| Words and timestamps | `nvidia/nemotron-3.5-asr-streaming-0.6b`, Q8 GGUF |
| Local speaker turns | `nvidia/Nemotron-3-Diarization`, Q8 GGUF |
| Native inference | NeMo-Speech.cpp, Vulkan or CPU |
| Voice fingerprints and cross-window grouping | Existing Python/NeMo TitaNet pipeline |
| Jobs, transcript merging, saved-profile matching, persistence in Next | Rust |

NeMo-Speech.cpp is a runtime; Nemotron ASR and Nemotron Diarization are separate
models. Diarization alone does not replace Parakeet's transcription function.
**Python/PyTorch has not been removed from voice matching.** On this PC the
embedding worker uses CUDA when available, or CPU when selected.

The pinned runtime revision is
`4c101bc7113f49101a3e11d2c994c519f41939f6`. Model checksums are pinned in
`server/nemo-runtime.ts` and `desktop/src-tauri/src/speech.rs`. The coordinator
uses 180-second outer ASR chunks and the tested 1,120 ms streaming context;
diarization uses 120-second windows, 10-second overlap, and the existing 0.65
grouping threshold. Do not silently change these while comparing implementations.

Nemotron has eight local speaker slots per window. Concord's overlapping windows
and voice matching link more than eight global identities across a recording;
this is not two fixed groups of eight. The October 22 recording produced 11 groups
for 11 reported participants. October 7 produced 12 groups for 10 reported
participants, retaining the known voices but leaving extra/split groups to review.
This demonstrates operation beyond eight; a real 16-person accuracy validation
has not been performed. Do not impose an eight-person library limit or describe
16-person recognition as proven.

The user selected minutes **17–27 of October 7** to inspect English missed around
glossolalia. Their listening comparison drove the multilingual model choice.
Do not treat additional phonetic words during glossolalia as verified speech.

On the development i7-13700K / RTX 2080 Ti, the existing-interface integration
processed the full approximately 135- and 179-minute meetings in about 217 and
276 seconds, including diarization and merging. These are local measurements,
not cross-platform promises. Selected native multilingual ASR excerpts used about
930 MiB sampled worker VRAM; native diarization used about 173 MiB. These figures
exclude other stages and are **not total application VRAM requirements**.
Matched-context multilingual CPU performance, low-end PCs, macOS, and Windows
still need validation.

Detailed evidence:

- [Diarization results](../experiments/diarization/RESULTS.md)
- [Native Parakeet runtime comparison](../experiments/diarization/ASR_RESULTS.md)
- [Nemotron ASR comparison](../experiments/diarization/NEMOTRON_ASR_RESULTS.md)
- [Existing-interface NeMo integration](nemo-native.md)

## What Concord Next currently does

- **Design system.** Tokens use tweakcn/shadcn names. The Concord brand theme comes
  in dark (default) and light, plus the 12 tweakcn themes from the Electron app
  (Settings → Appearance). Fonts are vendored: Inter, Source Serif 4 (titles,
  transcripts, documents; a Serif/Sans switch is in Settings), and JetBrains Mono.
- **Shell.** A grouped sidebar collapses to an icon rail under 1200px; phones get a
  bottom tab bar. There is a Ctrl+K command palette (recordings, speakers, notes,
  documents, actions), toasts with actions, an Activity panel, and hash routes
  (`#/recording/<id>?t=…`, `#/search?q=…`, …).
- **Library.** Grid and list views, filters (collection, type, transcript, review,
  starred), six sorts, page sizes of 60/120/240, stars, review state, resume
  progress, colored speaker chips, and a ⋮ menu (open, resume, (re)transcribe,
  review, star, show in folder, copy path). Settings persist.
- **Player.**
  - Custom transport with speed and volume, and a timeline with a waveform (audio),
    speaker lanes, saved-note markers, and a playhead.
  - Resume, previous/next, speaker panel with naming, and keyboard control (`?`
    lists shortcuts).
  - Transcript follow-along with "Back to playback", and find with highlighted
    matches.
  - **Ranges:** shift-click, select text across lines, or press I/O, then drag the
    timeline handles to fine-tune. Loop, copy, save as note, and export as M4A,
    MP3, MP4 (accurate or fast), TXT, Markdown, or SRT via the save dialog, with
    "Show in folder".
- **Search.** Word search grouped by recording, with highlighted matches and
  speaker names. Semantic search and AI are not implemented yet.
- **Speakers** lists voices by speaking time. A row expands to show the speaker's
  notes (saved on blur) and every recording they appear in; play opens the
  recording at their longest turn. Edit, rescan, merge, noise, and the unidentified
  queue remain for Delivery 2.
- **Documents** render Markdown. Notes and Map are restyled; their rebuilds are
  Deliveries 3 and 5.
- Imports the old library into its own SQLite database, transcribes through the
  tested NeMo coordinator, and streams media over loopback, all unchanged from 0.1.

Schema version 2 adds `media.starred`, `review_state`, `position`, and `opened_at`
(an idempotent migration, safe with the 0.1 app still running).
The imported snapshot contains **2,020 recordings, 49 saved voices, 595 documents,
5 notes, and 957,728 transcript search rows**. Counts are a snapshot, not constants.

## Architecture and important fixes

| File or directory | Responsibility |
| --- | --- |
| `desktop/src/App.tsx` | Shell, routing, app context, job polling |
| `desktop/src/lib/` | Typed IPC seam (`ipc.ts`), formatting, routing, ranges, time store, shortcuts, search helpers (tested with `node --test`) |
| `desktop/src/theme/`, `desktop/src/fonts/` | Brand theme, tokens, tweakcn theme scoping, vendored fonts |
| `desktop/src/ui/` | Primitives on Radix: buttons, menus, dialogs/sheets, selects, toasts |
| `desktop/src/shell/`, `library/`, `player/`, `search/`, `documents/`, `notes/`, `speakers/`, `map/`, `settings/` | Feature folders with co-located CSS |
| `desktop/src/dev/`, `desktop/scripts/screens.mjs` | Dev-only mock host (`?mock`) and headless screenshot runner |
| `desktop/src-tauri/src/lib.rs` | Tauri IPC commands, app state, single-instance behavior, shutdown |
| `desktop/src-tauri/src/db.rs` | SQLite schema and migration, import, library filters, palette, search, speaker assignment |
| `desktop/src-tauri/src/export.rs` | Range excerpts, TXT/MD/SRT rendering, ffmpeg media export with progress and cancel |
| `desktop/src-tauri/src/waveform.rs`, `system.rs` | Cached audio peaks; show in folder (D-Bus FileManager1, xdg-open fallback) |
| `desktop/src-tauri/src/speech.rs` | Runtime discovery, model verification, jobs, process groups, publication |
| `desktop/src-tauri/src/transcript.rs` | Word/turn merging, short-turn cleanup, cosine matching |
| `desktop/src-tauri/src/playback.rs` | Loopback media streaming and byte-range handling |
| `desktop/src-tauri/src/thumbnail.rs` | Thumbnail cache reuse and frame extraction |
| `desktop/src-tauri/src/main.rs` | Linux NVIDIA/Wayland rendering workaround |
| `server/transcription-engines/transcribe-nemo.py` | Reused speech coordinator; imports existing helpers including `diarize-sortformer.py` |
| `assets/brand/` | User-supplied `concord-icon.svg`, mono icon, and wordmark |

There is no Electron runtime or Node application server in Next. Application
commands use Tauri IPC. **Media playback is an intentional exception:** Rust binds
to `127.0.0.1` on an ephemeral port and streams only the most recently registered
recording using unguessable session URLs. It supports GET/HEAD and bounded byte
ranges; it does not serve directories or an application HTTP API. There is no
fixed browser UI port for the installed app. Vite development uses port 1420.

Three Linux playback/rendering problems were found and addressed:

1. NVIDIA/Wayland caused WebKitGTK `Gdk Error 71`. `main.rs` sets
   `WEBKIT_DISABLE_DMABUF_RENDERER=1` only when Wayland and the NVIDIA driver are
   detected, preserving an explicitly supplied value. This is app-local and does
   not disable speech GPU acceleration.
2. The host lacked some playback codecs. The AppImage now bundles GStreamer media
   plugins, including AV1 and libav support. FFmpeg alone does not supply the
   webview's GStreamer decoders.
3. WebKitGTK rejected Tauri's `asset:` URLs for media. Adding codecs alone did not
   fix this. The loopback streaming path fixed playback; scoped asset URLs remain
   suitable for thumbnails. Do not revert media to `convertFileSrc()` without
   validating Linux playback.

## Installed apps and local data

Paths below describe this development PC. XDG locations and environment overrides
are supported; do not hardcode this home directory into application code.

| Item | Location |
| --- | --- |
| Repository | `/home/pc/Documents/GitHub/Concord` |
| Original installed app | `~/.local/opt/concord/Concord.AppImage` |
| Original database | `~/.local/share/concord/pipeline.db` |
| Native preview | `~/.local/opt/concord-next/Concord-Next.AppImage` |
| Preview launcher | `~/.local/share/applications/concord-next.desktop` |
| Preview database | `~/.local/share/concord-next/library.db` |
| Preview transcripts, thumbnails, logs | `~/.local/share/concord-next/` |
| Reused speech models | `~/.local/share/concord/models/nemo/` |
| Reused voice environment | `~/.local/share/concord/venv/bin/python` |
| Cached C++ runtime source/build | `~/.cache/concord-diarization-lab/NeMo-Speech.cpp/` |
| Private experiment outputs | `~/.local/share/concord-diarization-lab/` |
| Original Claude conversation reference | `~/.claude/projects/-home-pc-Documents-GitHub-Concord/` |

The preview identifier is `app.concord.next`. It reads media in place, including
external drives, so those drives must remain connected. Imported transcripts are
initially read from their original paths. Re-transcription writes a new version
under Next's data root and updates only Next's database. A failed or cancelled job
preserves the previous transcript. Import requires an empty destination library;
do not delete the working preview database just to rerun import.

Use `CONCORD_NEXT_DATA` for isolated test profiles. Runtime overrides are
`CONCORD_NEMO_BIN`, `CONCORD_NEMO_MODELS`, and `CONCORD_SPEAKER_PYTHON`.

Private test inputs supplied by the user are `/home/pc/Videos/2025-10-07.ogg` and
`/home/pc/Videos/2025-10-22.ogg`. The ten-minute integration excerpt is
`~/.local/share/concord-diarization-lab/asr/clips/2025-10-07-1020s-600s.wav`.
Do not commit recordings, transcripts, databases, model weights, or credentials.
An unrelated untracked `.aws` entry is present in the checkout: leave it untouched
and excluded from commits.

## Build and install

Run from the repository root. Standard prerequisites are in [README](../README.md).
The native preview currently reuses speech setup from the original NeMo app.

```sh
pnpm install --frozen-lockfile
bash scripts/stage-nemo-runtime.sh
pnpm --dir desktop desktop
```

For the installed build on this PC:

```sh
PATH="$HOME/.cache/concord-build-tools:$PATH" pnpm --dir desktop package
bash scripts/install-next-local.sh   # installs the newest bundle in target/release/bundle/appimage
"$HOME/.local/opt/concord-next/Concord-Next.AppImage"
```

The PATH prefix supplies the locally staged `patchelf`; it is not a general
requirement on machines where patchelf is already installed. Two additional
distro-matched GStreamer plugins were extracted from signature-verified Arch
packages into ignored `build/binaries/gstreamer/`. The packaging script discovers
that directory, or accepts `CONCORD_GST_PLUGINS`. Do not reuse these binaries on
an unrelated distro or GStreamer release. System packages were not changed.

`scripts/package-next-linux.sh` validates codecs and stages GStreamer plugins and
helpers for the AppImage. It handles Arch's scanner path. The local installer
atomically replaces only the Next AppImage and installs the supplied icon and a
separate launcher. Close/reopen Next to use a new build; check for an active job
or unsaved work before restarting it.

Latest bundles (0.2.0) are under `desktop/src-tauri/target/release/bundle/`: approximately
171.81 MiB AppImage and 59.94 MiB Debian package, excluding model weights and the
Python environment. Only the AppImage has been installed and exercised here.
Build-host compatibility still needs broader testing. Do not edit a packaging
shell script while an invocation of that same script is running.

## Verification completed and remaining

Delivery 1 (0.2.0), verified on this PC:

- **Tests.** 31 TypeScript unit tests (`pnpm --dir desktop test:ts`: formatting,
  routes, ranges, time store, shortcuts, search, themes, voices) and 30 Rust tests
  plus 1 ignored real-speech test. The Rust tests cover:
  - migration v2 on a v1 database;
  - library filters and sorts;
  - star, review, and position;
  - palette, search highlighting, speaker order, appearances, and notes;
  - TXT/MD/SRT rendering;
  - real ffmpeg exports of M4A, MP3, and MP4 (accurate and fast), checked with ffprobe
    (±0.2 s), plus cancellation and the missing-media error;
  - waveform peaks and cache.
- **Lint and build.** Clippy passes with warnings denied, and the tsc/Vite build
  passes.
- **Visual review.** The screenshot matrix (12 pages × desktop/960/tablet/phone ×
  dark/light) and three tweakcn themes were reviewed in headless Chromium with the
  mock host.
- **Interaction probes** over CDP:
  - resume at `?t=`, Space/arrow shortcuts, Space ignored in fields, follow-pill;
  - click-to-seek, shift-click ranges, text selection mapped to lines, I/O, play
    range stopping at its end, loop;
  - export flow and toast, Save note prefill.
- **Real WebKitGTK window** (review build, copy of the real library):
  - the migration ran (schema version 2);
  - Library loaded 2,020 recordings;
  - starring persisted through IPC;
  - Speakers listed 49 voices by airtime.

Not yet verified in the real window: media playback of the new player, the native
save dialog and a real export from the UI, "Show in folder" (D-Bus FileManager1),
clipboard copy in WebKitGTK, and phone-width behavior on an actual phone.

Reproduction commands:

```sh
pnpm --dir desktop test:ts
pnpm --dir desktop build
cargo test --manifest-path desktop/src-tauri/Cargo.toml
cargo clippy --manifest-path desktop/src-tauri/Cargo.toml --all-targets -- -D warnings
pnpm --dir desktop dev   # then open http://127.0.0.1:1420/?mock for the mock host
node desktop/scripts/screens.mjs <outdir> [name-filter]
```

Native UI inspection works with `orca-ide computer` accessibility commands. The
Linux provider has no screenshots and indexes go stale after re-renders, so refresh
state before every click. `grim` captures only the visible workspace, so never grab
a window on a hidden workspace. Outside Orca-managed terminals, do not run bare
`orca`, which is the GNOME screen reader on this PC.

## Remaining work and suggested continuation

Follow the delivery plan above: **Speakers** next (Delivery 2), then Notes, Search
and AI, Map, and Channels/pipeline. Keep delivering installed builds of Concord Next
and leave the parked Electron app available. Each delivery gets a short spec and a
plan under `docs/superpowers/`, with TDD, the mock screenshot matrix, and a
real-window check.

Carry-overs from Delivery 1:
- Verify the real-window items listed above: playback, the save dialog, reveal, and
  the clipboard.
- **Speech setup.** Port a self-contained speech installer and model management;
  today Next needs the original app's managed environment. Benchmark the
  multilingual configuration on CPU.
- **Batch re-transcription** of the whole archive (planned with Delivery 6). Jobs run
  one at a time and are not resumed after restart. Preserve manual speaker labels
  across re-transcription by matching old labelled voices to new ones by time
  overlap.
- **Public release preparation:** fresh-machine setup, packaging on supported Linux
  bases, CI, dependency and license review. The root package scripts and legacy
  source still contain the old application.
- **macOS, then Windows** builds and on-device validation.

Keep model improvements separate from speaker-count claims, and evaluate future
model changes through the working end-to-end pipeline. The current choice is the
multilingual Nemotron model the user preferred; do not restart the comparison or
replace clustering without a concrete reason.
