# Brief for Codex: first-run setup (onboarding)

Written by Claude on October 1, 2026. The user approved this design. Claude isn't editing code,
so work where you normally work. Read the whole brief before starting.

The visual design is on a private Claude canvas (the user can share it, but you probably can't
open it). This brief is self-contained: every screen, state, and piece of copy is below.

## 1. Read first

- `docs/HANDOFF.md`: product context and decisions.
- `docs/superpowers/specs/2026-09-30-next-foundation-polish-design.md`: tokens, responsive and
  touch rules, and the IPC seam. Every new screen follows it.
- The current first-run pieces:
  - `desktop/src/library/Welcome.tsx`, which `LibraryPage.tsx:118` shows when
    `overview.media === 0 && !overview.libraryStarted`.
  - `desktop/src/settings/SpeechSetup.tsx` and `src-tauri/src/speech_setup.rs`.
  - AI providers: `ai/config.rs`, `ai/builtin.rs`, `ai/chatgpt/`, and in `lib/ipc.ts`
    `aiSaveProvider`, `aiCheck`, `aiModels`, `chatgpt*`, and `pipelineAiSave`.

## 2. Goal and principles

A new install today lands on Welcome and then nothing. Speech fails at run time with
"Nemotron or voice matching is not installed" (`speech.rs:334`), and AI setup sits in Settings.
Replace that with a short guided setup plus a checklist that stays around.

- **Only step 1 (Library) is required.** Every other step has "Skip for now". From step 2 on,
  "Finish setup later" exits to the Library page.
- **Never block.** Large downloads run in the background, and the user keeps moving through
  setup while they run.
- **Say the cost first.** Show sizes, the free-disk check, and what leaves the computer before
  the user commits.
- **Pick up where you left off.** Anything skipped or still running appears in a checklist on
  the Library page and in Status & Health. Features explain what's missing at the moment
  they're needed, instead of failing.

## 3. Flow and persistence

- **Route.** `#/setup?step=library|speech|recordings|ai|look|ready`. Add it to `lib/router.ts`.
  Setup is full-window: no app sidebar or top bar.
- **Layout at 960px and wider.** A 272px step rail on the left with the brand at the top and
  five steps: Library, Speech engine, Recordings, Search & AI, Look & feel. The content column
  is at most about 860px wide, with a footer bar holding Back, an empty spacer, "Skip for now",
  and the primary button.
- **Layout below 960px.** No rail. A top bar holds Back (44px), "Step N of 5", and Skip, with a
  5-segment progress bar under it. The primary button is full width in a bottom bar. The page
  scrolls.
- **Rail item states.**
  - **Current:** amber dot with the step number; the row is highlighted.
  - **Done:** green check, with a short summary underneath ("New library", "1 folder",
    "Local search · OpenRouter chat").
  - **Running:** amber spinner, "Installing · 38%", and a thin progress bar. Speech shows this
    on every later step while it downloads.
  - **To do:** number in a muted ring, with "Optional" or "Recommended" underneath.
  - Rail items are links, so the user can jump back.
- **When setup opens.** Open it automatically only on a fresh install, using the same
  condition Welcome uses today. Never force it on an existing library. Welcome.tsx goes away;
  its content becomes step 1.
- **State.** Store setup state in the DB `settings` table, not localStorage, so it survives a
  reinstall of the app:
  - `onboarding.step`: the last step shown. Reopening the app mid-setup resumes there.
  - `onboarding.completed`: set by "Open my library" or "Finish setup later".
  - `onboarding.skipped`: a JSON array of step ids.
  - `onboarding.checklist_hidden`: set by "Hide checklist".

## 4. Screens

Colors in the design are the Concord dark theme. Use tokens only:
- amber: `--primary`;
- green for success: `--chart-3`;
- blue for info: `--chart-2`;
- cards: `--card`;
- borders: `--border`.

Headings use `--font-serif`, at 34px on desktop and about 26px on phone. The eyebrow above each
heading is 12px, uppercase, and letter-spaced.

### Step 1: Library (`step=library`, required)

- **Eyebrow:** "Welcome to Concord".
- **Heading:** "Let's set up your library".
- **Body:** "Concord keeps your recordings, transcripts, speakers and notes on this computer.
  Setup takes a few minutes, and only this first choice is required."
- **Previous-library card.** Shown only when the legacy library is detected (§5.2).
  - **Title:** "We found your library from the previous Concord app".
  - **Path:** the legacy path in mono, for example `~/.local/share/concord`.
  - **Chips:** "N recordings", "N speakers", "N notes", and a green "Speech models can be
    reused" chip when they verify.
  - **"Import this library"** (primary) runs the existing import with that path and no file
    picker.
  - **"Start fresh instead"** (ghost) dismisses the card.
- **Two option cards.**
  - **"Start a new library":** "An empty library. You'll add recordings in a moment." Calls
    `startLibrary()`, then goes to the Speech step.
  - **"Import a library…":** "From another computer or a backup. Recordings, speaker profiles
    and notes come across." Uses the existing file-picker import.
  - While an import runs, show a busy state on the card that started it. On success, go to
    Speech.
- **Footer text, no buttons:** "Your library is stored on this computer in <data root>".
  Display the real path, with `~` for the home directory.

### Step 2: Speech engine (`step=speech`, recommended)

- **Eyebrow:** "Step 2 of 5 · Recommended".
- **Heading:** "Install the speech engine".
- **Body:** "Transcription and speaker detection run entirely on this computer, so your
  recordings never leave it."
- **"Run it on":** two radio cards. They write the single device preference (§5.5).
  - **Graphics card:** with a green "Detected" badge, the GPU name from `speech_status`
    followed by " · Vulkan", and "Much faster on long recordings." Preselected when a GPU is
    found. When none is found, disable this card and show "No compatible graphics card found".
  - **Processor only:** "Works on any computer", and "Slower, but always available."
- **"What gets installed":** a bordered table. Each row has a name, detail, and size:
  - Speech recognition · Nemotron 3.5 ASR · 741.5 MB
  - Speaker separation · Nemotron diarization · 107.0 MB
  - Voice matching · TitaNet · 101.6 MB
  - Voice-matching runtime · Python 3.12 + PyTorch (CPU) · **measure it** (see below)

  The size column shows a green "Already here" when that model is reusable.

  Then a footer row labeled "Download":
  - Fresh install: "About 950 MB of models, plus the runtime".
  - Models reusable: "Runtime only. Models are reused from the previous Concord app."
- **Measure the runtime.** Run a real setup into a scratch data dir and measure
  `speech/environments/<id>` plus any uv cache it fills. Put the real figure in the copy,
  for example "about 2.1 GB". The mockup says "several GB" only because nobody has measured it.
- **Preflight row** (§5.3), as inline items with green checks:
  - **Disk:** "186 GB free". When it's too low, show "Needs about X GB free. Y GB available."
    in the destructive color.
  - **Network:** "Download servers reachable". On failure: "Can't reach the download servers.
    Check your connection.", with a Retry button.
  - **ffmpeg:** "ffmpeg found". When missing: "ffmpeg is missing. Install it with your system's
    package manager."
  - **Info item:** "Installs in the background. If Concord closes, it picks up where it
    stopped."
- **Footer:** Back, "Skip for now", and the primary "Install and continue" (download icon).
  - "Install and continue" calls `speechSetupStart()` and moves to Recordings without
    waiting.
  - It's disabled while a blocking preflight check fails: disk, network, or ffmpeg.
- **Re-entry states.**
  - Already installed: replace the table with "The speech engine is installed", show its
    device, and make the primary button "Continue".
  - Setup running: show a progress bar and "608 of 950 MB · 64%", plus Pause.
  - Setup failed: show the error, a Retry button, and a "Show log" link.

### Step 3: Recordings (`step=recordings`, optional)

- **Eyebrow:** "Step 3 of 5 · Optional".
- **Heading:** "Bring in your recordings".
- **Body:** "Add some now or later. Anything you add is transcribed as soon as the speech
  engine finishes installing." If speech was skipped, the second sentence reads "Recordings you
  add wait until the speech engine is installed."
- **A 2×2 grid of tiles.** Each tile is a button with an icon, title, and one line of text:
  - **"Add files":** "Audio or video from this computer. You can also drag them in any time."
    Opens the file picker and uses the existing media import.
  - **"Add a folder":** "Imports the audio and video inside it." Adds a pipeline folder source.
  - **"YouTube channel or playlist":** "Queues its videos to download and transcribe." Opens a
    small dialog with a URL field and adds a pipeline YouTube source.
  - **"Documents folder":** "PDF, Word and Markdown files, searchable in Docs." Calls
    `addDocumentRoot`.
- **"Added" list.**
  - Helper text: "Personal and Work stay separate. Switch between them from the top bar."
  - Each row shows an icon, a title, a mono path, a count ("23 recordings"), a
    Personal/Work segmented control, and a remove button.
  - The category defaults to the top bar's current one, or Personal when that's set to Both.
- **Queueing.** Anything added here is queued for transcription. When speech isn't ready yet,
  the job **waits** instead of failing (§5.9).
- **Footer:** Back, "Skip for now", and "Continue".

### Step 4: Search & AI (`step=ai`, optional)

- **Eyebrow:** "Step 4 of 5 · Optional".
- **Heading:** "Search by meaning, and ask questions".
- **Body:** "Two separate features, each with its own provider. Search on this computer and
  chat through OpenRouter, for example."
- **Layout.** Two columns on desktop. Left: the Smart search card, with the "What leaves this
  computer" box under it. Right: the Ask your archive card. On phone, one card at a time,
  switched with a two-segment control ("Smart search" | "Ask your archive").
- **Smart search card.**
  - Header: "Smart search", and "Finds passages by meaning, not just exact words."
  - Radio rows, 42px tall, each with a label, a hint on the right, and optional badges:
    - **On this computer:** "Recommended" badge, hint "639 MB download".
    - **Local server:** hint "Ollama or LM Studio".
    - **OpenRouter:** hint "Uses your API key".
    - **Off:** hint "Exact words only". If the embedding config has no off state, add one.
  - Saved with `aiSaveProvider("embedding", …)`.
  - Choosing built-in queues the embedding model download (§5.6).
- **Ask your archive card.**
  - Header: "Ask your archive", and "Answers questions with quotes that jump to the moment."
  - Radio rows:
    - **Not now:** the default, hint "Add it later".
    - **ChatGPT account:** hint "Sign in, uses your plan".
    - **OpenRouter:** hint "API key, many models".
    - **Local server:** hint is the probed address, with a green "Found" badge when the probe
      succeeds (§5.7).
    - **Other:** hint "OpenAI-compatible address".
  - **Panel under the rows**, depending on the choice:
    - **Not now:** "Concord works fully without chat. Connect a provider any time in
      Settings › AI."
    - **ChatGPT:** a "Sign in with ChatGPT" button (external-link icon) with "Opens your
      browser. Concord never sees your password." Use the existing `chatgptStart` flow,
      including plan consent. Once signed in, show "Signed in as <account>".
    - **OpenRouter:**
      - "OpenRouter API key" label, with a "Get a key" link to `https://openrouter.ai/keys`.
      - A password input, with a "Test" button beside it.
      - If OpenRouter is also the Smart search provider, prefill the key.
    - **Local server:** the address in mono, a green "Ollama is running" chip, and "Test".
    - **Other:** an address input, an optional key input, and "Test".
  - **After a passing Test** (`aiCheck("chat")`): show a green "Connected" and a model picker
    filled from `aiModels("chat")`.
  - **Once chat is connected,** show a switch: "Summarize new recordings after they're
    transcribed". It calls `pipelineAiSave`.
- **"What leaves this computer" box.** Shield icon in `--chart-2`. It shows one line for the
  current search choice, one for the current chat choice, then a fixed line.

  | Choice | Line |
  |---|---|
  | Search on this computer | Search runs on this computer. |
  | Search local server | Search uses your local server and stays on this computer. |
  | Search OpenRouter | Search sends transcript text to OpenRouter to build its index. |
  | Search off | Search matches exact words only, on this computer. |
  | Chat not now | No chat provider is connected. |
  | ChatGPT | Chat sends your question and the matching passages to OpenAI. |
  | Chat OpenRouter | Chat sends your question and the matching passages to OpenRouter. |
  | Chat local server | Chat uses your local server and stays on this computer. |
  | Chat other | Chat sends your question and the matching passages to the address you enter. |

  The fixed line: "Keys are saved only on this computer, readable only by you."
  `ai-providers.json` is already mode 0600; keep it that way.
- **Footer:** Back, "Skip for now", and "Continue".

### Step 5: Look & feel (`step=look`, optional)

- **Eyebrow:** "Step 5 of 5 · Optional".
- **Heading:** "Make it yours".
- **Body:** "Change any of this later in Settings › Appearance."
- **Controls** in the left column. All of them apply live, because this is the real app theme:
  - **Appearance:** Light / Dark / Match system. This is `appearance-v1.mode`.
  - **Theme:** a 5-column grid of swatch buttons, one per entry in `THEMES`, each showing the
    theme's `--primary` and its name. The selected one gets an amber border.
  - **Transcript text:** Serif / Sans. This is `appearance.reading`.
  - **Size:** S / M / L. This is **new**: add `size` to `Appearance` and drive the transcript
    font size from it (about 14, 16, and 18px).
  - **Show by default:** Personal / Work / Both. This is `archive-category-v1`. Helper text:
    "Switch any time from the top bar."
- **Preview** in the right column: a card shaped like the player, with a header row and three
  transcript lines (time, speaker name in the speaker color, text). The current line is
  tinted. The preview uses the real transcript classes, so it reflects every control.
- **Footer:** Back, and the primary "Finish setup".

### Ready (`step=ready`)

- The rail shows every step as done or running. No eyebrow.
- A green check circle above the heading **"Your library is ready"**.
- **Body:** "Here's where things stand. Anything still running or skipped waits for you on the
  Library page."
- **A bordered list with one row per area:** Library, Speech engine, Recordings, Smart search,
  Ask your archive, and Look & feel. Each row shows a status icon, a bold label, and a summary
  line.
  - **Speech while it installs:** "Installing on the graphics card", "608 of 950 MB · 64%", a
    progress bar, "Recordings you add now are transcribed as soon as it finishes.", and a
    Pause button.
  - **Smart search queued behind speech:** "On this computer · downloads after the speech
    engine (639 MB)".
  - **Skipped rows:** "Skipped", with a "Set up" link back to that step.
- **Primary button "Open my library":** sets `onboarding.completed` and goes to `#/library`.

## 5. Backend and plumbing

1. **`setup_status` command.**
   - One call returns:
     - library started, plus import info;
     - speech: installed, running with progress, failed with error, device, and GPU name;
     - source and document-root counts;
     - the embedding provider and whether its model is downloaded;
     - chat connected;
     - the onboarding settings.
   - Setup screens, the checklist, and the sidebar Status item all read from it, so there's
     no assembling the same state from five calls.
2. **Detect the legacy library.**
   - `legacy_library_summary` returns `{ path, recordings, speakers, notes,
     speechModelsReusable }`, or null.
   - Open the DB at `legacy_root()` **read-only** (`SQLITE_OPEN_READ_ONLY`), and never migrate
     or write it.
   - `speechModelsReusable` uses the same verification `speech_setup.rs` already applies to
     legacy models. Don't start setup to answer this.
3. **Speech preflight.**
   - `speech_setup_preflight` returns:
     - free bytes on the data root's filesystem, and bytes needed (models not already reusable,
       plus the measured runtime size);
     - whether Hugging Face and NGC answer a HEAD request with about a 5-second timeout;
     - whether ffmpeg is on PATH.
   - Use `statvfs` through `libc` if it's already a dependency. If it would need a new crate,
     ask the user first.
4. **Resume interrupted downloads.**
   - Write to `<file>.part` and resume with an HTTP `Range` request.
   - Keep the existing SHA-256 pinning. A failed hash deletes the part file and restarts that
     file.
   - The status `interrupted` should resume when setup starts again, and the app should
     offer to resume on next launch.
5. **One device preference.**
   - Today the device lives in localStorage `speech-device` (`App.tsx:51`) and in
     `pipeline.config.device`. Make a DB setting `speech.device` (`auto|gpu|cpu`) the only
     source.
   - Migrate any existing localStorage value once, then delete the key.
   - The pipeline worker and manual transcribe both read the DB setting.
6. **Built-in embedding download.**
   - `ai/builtin.rs` downloads Qwen3-Embedding-0.6B (639 MB) lazily, with no progress. Add a
     status command and a start command.
   - When both downloads start during setup, run this one after speech setup.
   - Report its progress the same way speech setup does.
7. **Local server probe.**
   - `ai_probe_local` checks `127.0.0.1:11434` (Ollama) and `127.0.0.1:1234` (LM Studio),
     loopback only, with about a 300ms timeout.
   - It returns what it found and a model count.
8. **Deep links.**
   - `#/settings?section=appearance|ai|speech|library` scrolls to and briefly highlights that
     section.
   - `#/pipeline?tab=sources` opens the Sources tab.
   - The checklist, prompts, and "Set up" links use these.
9. **Transcribe waits for speech instead of failing.**
   - When speech isn't ready, a transcribe request or a pipeline job enters a waiting state
     ("Waiting for speech engine") and starts when setup completes.
   - It fails only when setup itself fails, with that error.
   - `speech.rs:334` should no longer be the first thing a new user sees.

## 6. After setup

- **Checklist on the Library page.**
  - It sits above the content and is shown while any item is incomplete and
    `onboarding.checklist_hidden` is unset.
  - **Header:** "Finish setting up", "N of 5 done", a 5-segment bar (green for done, amber for
    running, muted for to-do), and a "Hide checklist" ghost button.
  - **Rows, 58px tall:**
    - **Start your library:** a done row.
    - **Install the speech engine:** while running, "Installing on the graphics card · 64%"
      with a mini bar and a "Details" button that opens Status & Health. When skipped, an
      "Install" button.
    - **Add recordings:** "Files, a folder, YouTube, or documents", with a primary
      "Add files" button and a "More sources" button.
    - **Turn on Smart search:** "Search by meaning · 639 MB, on this computer", with a
      "Set up" button.
    - **Ask your archive:** "Chat with answers quoted from your recordings", with a
      "Connect" button.
  - **Empty library under the checklist:** a dashed drop zone with "Your library is empty" and
    "Drop audio or video files anywhere in this window."
- **"Setup" section in Status & Health.**
  - The same rows, always visible.
  - A "Show checklist on Library" switch that clears the hidden flag.
  - An "Open setup" link to `#/setup?step=speech`.
- **Sidebar Status item.**
  - While speech setup or the embedding download runs, the foot item becomes an amber-tinted
    block: a spinner, "Installing speech" (or "Downloading search model"), "608 of 950 MB ·
    64%", and a thin bar.
  - Clicking it opens Status & Health.
  - In the rail sidebar, the tooltip carries the same text.
- **Prompts at the moment of need.** These are the three prompts in the design.
  - **Transcribe before speech is ready.** The Transcribe button opens a popover anchored to
    it.
    - **Title:** "The speech engine isn't installed yet".
    - **Body:** "Transcription runs on this computer and needs about 950 MB of models, plus the
      voice-matching runtime. It installs in the background."
    - **Buttons:** the primary "Install and transcribe", which starts setup and queues the
      recording per §5.9, and "Not now".
    - **While installing:** the title becomes "Installing the speech engine", with a bar and
      "This recording is queued and starts by itself when the install finishes. Progress is
      in Status & Health."
  - **AI page with no chat provider.** An empty state:
    - **Icon:** a chat bubble.
    - **Title:** "Ask questions about your archive".
    - **Body:** "Connect a chat provider to get answers quoted from your recordings, each
      linked to the moment it was said."
    - **Three 42px buttons:** "Sign in with ChatGPT" (hint "Uses your plan"), "Use an
      OpenRouter key" (hint "Many models"), and "Use a local server" (green "Ollama found"
      badge when probed).
    - **Link:** "More options in Settings › AI".
  - **Search without Smart search.** An amber-tinted banner above the results:
    - **Text:** "Showing exact matches only. Smart search also finds passages that say it
      differently."
    - **Buttons:** the primary "Turn on · 639 MB, on this computer", and "Not now".
    - "Not now" persists the dismissal until Smart search is set up or the user turns it on
      from Settings.

## 7. Constraints

- **Frontend.**
  - Put the setup screens in `desktop/src/setup/`.
  - Use `ui/` primitives and theme tokens only: no literal colors, at least 44px touch targets,
    and no hover-only controls. Check dark and light themes.
  - All host calls go through `lib/ipc.ts`.
- **No new npm packages or crates without asking the user.** Never run `pnpm install`.
- **Data.**
  - Test the fresh-install path with an **empty** scratch dir:
    `CONCORD_NEXT_DATA=<empty dir>`.
  - Test legacy detection against the real `~/.local/share/concord` read-only, or against a
    copy.
  - Never write to the user's real libraries.
- **Mock host.** Add handlers to `dev/mock-ipc.ts` for every new command, with switchable
  states: fresh install, legacy found, speech installing, speech failed, chat connected.
  Screens must render with `?mock`.
- Never stage `.aws`. Never commit model weights, databases, recordings, or credentials.

## 8. Verification before calling it done

- Run:
  - `pnpm --dir desktop test:ts`
  - `pnpm --dir desktop build`
  - `cargo test --manifest-path desktop/src-tauri/Cargo.toml`
  - `cargo clippy --manifest-path desktop/src-tauri/Cargo.toml --all-targets -- -D warnings`
- Take screenshots with `desktop/scripts/screens.mjs` at desktop, 960, tablet, and phone
  widths, in dark and light themes, for each step and state.
- **Check in the real WebKitGTK window** with a separate identifier and an empty data dir.
  Walk the whole flow:
  - Start new, install speech, and skip ahead while it downloads.
  - Add a folder, then confirm its jobs wait and then run.
  - Connect a chat provider and test it.
  - Finish, and confirm the checklist and sidebar progress match.
  - Close the app mid-download, reopen it, and confirm the download resumes and setup resumes
    at the right step.
- Report the measured runtime size, and update the speech step's copy with it.

## 9. Out of scope

- Syncing legacy data beyond the existing import.
- Watchers.
- Changing the provider architecture.
- Re-designing Settings. Settings keeps its sections; setup reuses its save calls.
