# Concord — User Manual

For **Concord v2.4.4**. Reviewed against the app on **September 14, 2026**.

Concord is a personal research archive for videos, audio recordings, and Markdown documents. Download or import media, create local transcripts, find passages, save notes, compare sources, and ask questions about your archive.

Your library is stored on your computer. Downloads, model installation, and YouTube searches use the internet. Optional AI features send text to the model provider you configure, which can be on this computer, another machine, or a remote service.

## Contents

- [Install and update](#install-and-update)
- [First-run setup](#first-run-setup)
- [Header controls and navigation](#header-controls-and-navigation)
- [Add videos, subscriptions, and folders](#add-videos-subscriptions-and-folders)
- [Read, search, and take notes](#read-search-and-take-notes)
- [The main pages](#the-main-pages)
- [Optional AI and YouTube connections](#optional-ai-and-youtube-connections)
- [Voice notes](#voice-notes)
- [Settings reference](#settings-reference)
- [Troubleshooting](#troubleshooting)
- [Data and backups](#data-and-backups)

## Install and update

### Linux / Omarchy

1. Open [Concord Releases](https://github.com/GodsWildOnes/Concord/releases).
2. Expand **Assets** and download **Concord-2.4.4.AppImage**. The **Source code** ZIP and tarball contain the project files, not an installed application.
3. Put the AppImage somewhere you want to keep it, make it executable, and launch it:

   ```bash
   chmod +x Concord-2.4.4.AppImage
   ./Concord-2.4.4.AppImage
   ```

The v2.4.4 release provides a Linux **x86-64 AppImage**. You do not need to build the app, install Node.js, or clone the repository to use this file. It bundles the desktop runtime, FFmpeg, FFprobe, and yt-dlp. It still needs a compatible Linux system and the transcription prerequisites below; it is not a guarantee of compatibility with every distribution.

The repository is currently private. Sign into a GitHub account with access to see its releases. Sharing a private release link alone does not grant repository access.

For Linux transcription, have **Python 3.12** available with pip and venv support. The installer accepts Python 3.10–3.13 and prefers 3.12; it rejects Python 3.14 for the current dependency stack. If you use mise, you can install 3.12 alongside the system Python with `mise install python@3.12`.

For NVIDIA transcription, the driver must work and `nvidia-smi` must recognize the GPU. See the [README's hardware checks](README.md#nvidia--rtx-5090), including the separate RTX 5090 validation steps.

If launch fails, see [Troubleshooting](#troubleshooting). To run or build from source instead, follow the [README](README.md#run-from-source-on-linux--omarchy).

### Other packages

The project also has build targets for a Linux `.deb` and an Apple Silicon macOS `.dmg`. Download one only if that asset is actually listed on the release you are using. The v2.4.4 release described here supplies the Linux AppImage; it does not supply an Intel Mac or Windows installer.

For an Apple Silicon DMG build, open the DMG, drag Concord to Applications, and launch it. The macOS build bundles FluidAudio; its models download on first use. Allow microphone access when prompted if you want to record voice notes.

### Updating an installed copy

Close Concord, replace the AppImage that your launcher points to, and reopen it. A Git pull or source build alone does not update an already installed AppImage.

If your menu entry uses a fixed filename such as `Concord.AppImage`, replace that file while keeping the filename. Otherwise, update the launcher to point to the new versioned file. The version at the bottom of the expanded sidebar identifies the interface you are running.

Your archive and configuration live separately from the application file. Replacing the AppImage does not copy an archive from another machine or replace your existing library.

## First-run setup

A fresh installation opens **Pipeline → Setup**. Complete the required checks before downloading or transcribing. This is a shared workspace with three tabs:

| Tab | Use it for |
| --- | --- |
| **Run pipeline** | Add sources and individual videos, see processing jobs, and manage subscriptions. |
| **Setup** | Storage folders, download preferences, and transcription installation and hardware settings. |
| **AI & extras** | Optional AI connections, indexing, summaries, YouTube API configuration, and maintenance. |

### 1. Choose storage and download preferences

In **Storage & download settings**, choose **Video save** and **Transcripts** folders. Fresh installations leave these fields blank. Use absolute paths you can write to. The desktop AppImage includes a native picker; `zenity` and `kdialog` are not required. Updating the app preserves saved settings, so review the locations if you moved a profile from another computer.

When you use the folder picker, it appends `saved_videos` or `transcripts` to the selected parent directory. When you type a path yourself, the typed path is used. Review the final paths shown in the fields.

Choose download quality and codec, then click **Save storage & downloads**. **Schedule & advanced options** contains the check interval, daily cap, cookies, LAN access, audio-language preference, and retained-audio setting.

### 2. Set up transcription

| Hardware | Setup choice |
| --- | --- |
| Linux with a suitable NVIDIA GPU | The installer recommends **Parakeet** when it detects at least 8 GB VRAM. A single supported NVIDIA card is sufficient. |
| Linux without NVIDIA, including Ryzen with integrated Radeon graphics | Choose **Whisper**. The recommended CPU settings are model `small`, device `CPU`, and compute type `int8`. |
| Apple Silicon macOS | Use the bundled **FluidAudio** engine; no Python engine installation is required. |

On Linux, the installer creates a dedicated Python environment, installs the selected engine, checks that it imports, and saves the engine and Python path. It also applies the recommended model and hardware settings. Installation and first-use model downloads can take time; the duration depends on your machine and connection.

CPU mode means transcription runs on the processor. It does not enable integrated Radeon acceleration. Whisper does not provide Concord's speaker diarization; that option is disabled when installing Whisper. Model names and choices elsewhere in the app depend on the selected engine and platform.

Before installation, setup previews the recommended model and CPU/GPU settings together. **Model & hardware** becomes available once an engine is installed or an existing runtime is usable. NVIDIA GPU selection is disabled when no NVIDIA card is detected. Review this form, then click **Save transcription settings** if you change anything. An existing installation can use **Use recommended hardware settings** in its engine panel without reinstalling the environment.

### 3. Finish setup

When the required checks pass, click **Finish setup**. Completion is saved for this installation and survives restarts. On an already configured installation, the button reads **Go to pipeline**.

Finishing setup does not start downloads. You can use the archive without configuring a chat or embedding model. Try one short video or recording before queuing a large channel.

## Header controls and navigation

The sidebar contains the main pages. Collapse it to an icon rail with the top-left toggle; on small screens, use the menu button. The sidebar footer shows the app version.

**Start, Stop, and Check are in the header on every page.** On smaller windows their text labels collapse to icons: play, square, and circular arrows. Hover for the action name. The adjacent status shows whether the pipeline is running, stopped, or checking.

| Control | What it does in v2.4.4 |
| --- | --- |
| **Start** | Starts processing pending inventory and enables scheduled channel and Watcher checks. For a new YouTube source, run **Check** or **Full Scan** to create its initial inventory first. |
| **Check** | Checks enabled sources now and queues discoveries. It does not start the processing loop by itself. The first check of a new YouTube source can queue its existing catalogue. |
| **Stop** | Stops scheduled channel and Watcher checks. It does not cancel an active scan, download, transcription, or background indexing job. Already queued processing can continue after a job finishes. |

**Stopped is not an emergency cancel-all switch.** For separately managed background jobs, use their **Cancel** action on Status or Health. Check progress and Terminal output before assuming all work has finished.

Leave Concord open for its scheduled work. Starting the application does not automatically press **Start**; use the header controls after reopening when you want scheduled monitoring to run. If you change the check interval while running, stop and start again to apply the new timer interval.

Other header controls:

- **Search / Ctrl+K** opens the command palette to find content and run common navigation actions. On macOS, use Cmd+K.
- **Personal / Work / Both** filters views by category. If content seems to disappear, check this filter as well as the page's own filters.
- The separate **AI status dot** indicates whether the configured model provider is reachable. It is different from the Pipeline status.
- The **microphone** opens the voice recorder.
- The **gear** opens **Pipeline → Setup**. Theme controls change the appearance.

## Add videos, subscriptions, and folders

These are different ways to add material. Downloading one video does not subscribe to its channel. A Concord subscription is stored in Concord; it does not subscribe your YouTube account.

### Download and transcribe one YouTube video

1. Open **Pipeline → Run pipeline**.
2. In **Download a single video**, paste the video link into **YouTube video URL**.
3. Click **Preview video**. This retrieves details; it does not download the video yet.
4. Review the format or resolution in the preview and click **Download**.
5. Once it is saved to your configured folder, click **Transcribe with Pipeline** to create the transcript.
6. Open the finished item from **Library**.

The separate **Download** and **Transcribe with Pipeline** actions let you save a video without immediately transcribing it. Progress and errors appear in the preview and the Pipeline job list.

### Subscribe to a YouTube channel

1. Open **Pipeline → Run pipeline → Subscriptions & folders**.
2. Use **Add a source**, which is above **Your sources**.
3. Choose **YouTube channel**, enter a source name and a full channel URL such as `https://www.youtube.com/@channel`, choose Personal or Work, and click **Subscribe**.
4. Click **Check** in the header, or **Full Scan** on that source, to create the initial inventory.
5. Review the queued items and use **Start** in the header to process them and enable scheduled monitoring.

**The first Check on a YouTube channel with no inventory scans its existing catalogue. It is not limited to future uploads.** Later scheduled checks look for new items until they reach known videos. **Full Scan** walks the catalogue again to find missing entries. Start with a single video if you only want a small installation test.

Each source has an enable switch. Turning it off stops that source from being included in scheduled checks; it does not remove files or cancel items already queued. Use the pencil to rename a source.

For speaker labeling, both the global **Speaker diarization** switch and the source's **Identify speakers** switch matter. Turn source-level speaker identification off for recordings where it is unnecessary. **Include Shorts** controls whether channel scans include YouTube Shorts and is off by default.

### Add a local media folder

1. In **Subscriptions & folders → Add a source**, choose **Local folder**.
2. Enter a name, choose or type an absolute folder path, choose its category, and click **Add folder**.
3. Use the header's **Check** or that source's **Rescan** to find existing audio and video recursively.
4. Use **Start** to process pending files. While scheduled monitoring runs, later checks can find newly added files.

The folder must be accessible to the computer running Concord. A browser on another device cannot use this field to upload a folder from that device.

**Import folder** on a YouTube source has a different purpose: it scans that source's configured save folder for local files to bring into the library. It is not the control for selecting an arbitrary new watched folder.

Items under **One-off downloads (not subscribed)** represent existing downloads whose channels are not configured subscriptions. Their rename and import actions do not turn them into subscriptions.

## Read, search, and take notes

### Open a video workspace

Click an item in **Library** to open the video workspace. Use the layout controls to arrange the player and reading area. **Pop out** uses picture-in-picture when supported by the platform.

- **Transcript** contains timestamps, speaker labels, and a search field for this recording. Click a timestamp to seek.
- **Notes** contains your notes and saved evidence associated with the source.
- **Summary** contains the optional AI-generated summary, separate from your own notes.
- **Details** shows source information, provenance, and available duplicate matches.

When focus is outside a text field, Space toggles playback and Left/Right seek ten seconds. Shift-click a transcript row to extend a selection. Playback position is remembered.

### Save a passage as a note

1. On a transcript row, click **Clip**.
2. Add optional commentary and tags, then click **Save as new**.
3. To cover several rows, use **Start** and **End** on transcript rows, or extend a selection with Shift-click. Use **Save as new** for the selected range.
4. To attach a passage to a note you already have, use **Add to note** and choose the note.

Saved passages appear in **Notes** and can be connected in **Map**. A note may have several source anchors. The workspace also supports an overall source note; watch its save status after editing.

A saved note or clip is a reference to a passage. To create an actual media file containing an excerpt, use the workspace's export controls, choose its time range, and click **Export**. **Fast copy** and **Accurate** have different export behavior; changing the output resolution requires the accurate path.

### Search the archive

Open **Transcripts** and choose:

- **Words** for text matching. It works without an AI provider.
- **Meaning** for semantic search. It needs a compatible embedding model and an indexed archive.

Use the media/document and source filters to narrow results. A result's **Open at…** action opens the source at the matching timestamp. If the page returns nothing, check Personal/Work, source filters, and whether the item has finished transcribing or indexing.

### Compare sources and build connections

Use **Compare** to select two videos, documents, or notes and read them side by side. The shared comparison text can be stored with **Save as research note**. Pair-scoped AI requires your AI connection to be configured.

In **Map**, choose Videos, Cards, Arc, or Cluster layout. Select a relationship type, then connect note handles to record relationships such as **Same topic**, **Same claim**, **Contradicts**, **Follow-up**, or **Context**. Click a link to inspect or edit it.

## The main pages

### Content

| Page | Purpose |
| --- | --- |
| **Library** | Browse media in grid or list view. Search titles, channels, or paths; filter by processing state, transcript availability, review state, or stars; save useful views. Open an item to read or play it. |
| **Discover** | Search YouTube through the YouTube Data API, preview results, queue items, or save a search as a Watcher. |
| **Watchers** | Manage saved YouTube searches and review their Inbox. Phrase rules, allowed/blocked channels, polling intervals, Enabled, and Auto-queue determine what is found and queued. |
| **Transcripts** | Search transcript passages and indexed documents by words or meaning. |
| **Notes** | Create and organize research notes, tags, and source anchors. |
| **Docs** | Add roots containing Markdown (`.md`) files, browse and edit documents, and index their text. It is not a general PDF/Word importer. |

In Discover, Include/Exclude phrases affect the server-side search filtering as well as the result-card coloring. A filtered search may fetch several pages to collect matches; the colors are not the only effect. **Save as watcher** keeps the rules for later checks.

Watcher polling runs while the pipeline is running and the app remains open. Its per-watcher interval is checked on the pipeline's scanning cadence. With **Auto-queue** off, use **Queue** or **Dismiss** in the Inbox to review discoveries yourself.

### Analysis

| Page | Purpose |
| --- | --- |
| **Speakers** | Review detected voices, name or merge speaker identities, and inspect their appearances. Matching is automatic where possible, but you can correct labels. |
| **Map** | Connect and arrange research notes visually. |
| **AI** | Chat with the archive and follow citations back to supporting material. Conversations are saved; pin ones you want to revisit. |
| **Compare** | Read two sources together, save a shared research note, and ask questions within that pair. |

### Ops

| Page | Purpose |
| --- | --- |
| **Pipeline** | Use Run pipeline, Setup, and AI & extras to manage sources, processing configuration, and optional services. Start/Stop/Check remain in the global header. |
| **Status** | Inspect archive coverage, queue state, processing activity, and background jobs. Background jobs offer progress, cancellation, retries, and diagnostic export where applicable. |
| **Health** | Run an archive audit, review issues, apply the offered repairs, verify embedding dimensions, and create or restore database backups. |
| **Terminal** | Read and filter live server/tool logs, pause the display, and copy output. This is a read-only log viewer, not a command shell. Pausing the display does not stop work. |
| **Extract** | Extract an audio file from an existing local video. Choose M4A or MP3; the result is an audio file, not a transcript. |

## Optional AI and YouTube connections

### AI chat, summaries, and semantic search

Open **Pipeline → AI & extras**. In **Provider**, enter the **Base URL** and any required **API key**. Choose the **Chat model** and **Embedding model**, then click **Save**. **Refresh list** reloads available model names from the provider.

Concord supports an OpenAI-compatible endpoint on this computer, your LAN, or a remote provider. The presets include oMLX and Ollama; using a preset does not install or start that server.

The embedding index requires **1,024-dimensional** vectors. Use a model that actually returns that dimension; Health includes **Verify model dimensions**. A chat model alone does not enable semantic search.

Use **Reindex semantics** for existing media and **Index notes** for saved notes. These enqueue background work whose progress is available on Status. **Wipe existing first** rebuilds stored vectors; it is not required for ordinary missing-item indexing. Use **Generate summaries** to backfill AI summaries. Without **Overwrite**, existing summaries from the same model are skipped.

Local transcription and ordinary text search do not need an AI provider. Chat, embeddings, and summaries send the relevant text to the configured endpoint. If you choose a remote provider, that text leaves your computer.

### YouTube cookies

In **Pipeline → Setup → Storage & download settings → Schedule & advanced options**, either choose a browser under **YouTube cookies**, or provide a Netscape-format **Cookies file**. A file path overrides the browser choice. Click **Save storage & downloads**.

Cookies can help with content your logged-in account can access and with some YouTube download restrictions. They do not grant access your account lacks, and they are not required for every public video.

### YouTube Data API

Discover and Watchers use a separate YouTube Data API key. Ordinary Pipeline channel monitoring and direct video downloads use yt-dlp and do not require this key.

Create a Google Cloud project, enable **YouTube Data API v3**, create an API key restricted to that API, and save it in **Pipeline → AI & extras → YouTube Data API**. Google's [setup documentation](https://developers.google.com/youtube/v3/getting-started) describes the project and credentials steps.

Check the project's actual limits and usage in Google Cloud Console. Google's current default includes 100 `search.list` calls per day; a multi-page Discover search can consume several calls. The quota estimates displayed in Concord v2.4.4 use older accounting, so use the [current Google quota documentation](https://developers.google.com/youtube/v3/getting-started) and your project's console for the authoritative limits.

## Voice notes

Click the header's microphone button, allow microphone access, and start recording. Stop to finalize the recording and transcript, then open the saved item in Library. Complete transcription setup first.

Concord writes WAV audio locally while you speak. Interim transcript chunks can look rough; finalization processes the saved recording. Recording requires a browser/runtime that supports microphone access. A browser opened over a plain HTTP LAN address may not provide it; use the desktop app if the recorder is unavailable there.

## Settings reference

| Location / setting | Meaning |
| --- | --- |
| **Setup → Video save / Transcripts** | Output folders. Review the paths before saving, especially when using the folder picker. |
| **Download quality / Video codec** | Preferred maximum size and format for downloads. The source's available formats still determine what can be downloaded. |
| **Schedule & advanced options → Check interval (min)** | Scheduled source-check interval; the default is 1,440 minutes (24 hours). Stop and start to apply a changed running timer. |
| **Daily cap** | Default 200 downloads per day; zero disables the cap. Existing saved files and other jobs are not equivalent to new video downloads. |
| **Audio language** | Preferred YouTube audio-track language, such as `en`; it is not a translation setting. |
| **Keep audio** | Retains extracted audio alongside videos to reduce re-extraction work later. |
| **Download speed** | Timing preset for YouTube requests. |
| **Cookies** | Browser cookies or a cookies-file path; an explicit file takes precedence. |
| **LAN access** | Allows other devices to reach Concord's server. Save and restart to change the server's listening address. Paths still refer to the server computer. Enable it only on a network where you intend to share access. |
| **Transcription / Model & hardware** | Install or repair an engine, choose the model and device, and apply compatible compute settings. |
| **AI & extras → Provider / Models** | AI server URL, authentication, and model selections. |
| **Semantic search index / AI summaries** | Queue indexing and summary work. |
| **YouTube Data API** | Key used by Discover and Watchers. |
| **Library maintenance** | Inspect and repair archive records and derived indexes. Review what each action changes before applying it. |

Each settings section has its own save action. Theme and view filters are separate from processing configuration.

## Troubleshooting

### The menu opens an older version

Check the version at the bottom of the sidebar. The menu may point to a different AppImage from the file you just downloaded or built. Close the running app, replace the launcher's target file, and reopen it. Refreshing the window does not load code from a different AppImage.

### AppImage will not launch

First make the file executable and launch it from a terminal to see the error. For a FUSE/mount error, AppImage supports [extract-and-run](https://docs.appimage.org/user-guide/troubleshooting/fuse.html):

```bash
./Concord-2.4.4.AppImage --appimage-extract-and-run
```

An Electron sandbox error is different from a FUSE error. On systems where the trusted AppImage cannot initialize its sandbox, `./Concord-2.4.4.AppImage --no-sandbox` is a launch workaround. It disables Chromium's process sandbox, so prefer a working sandbox where your system supports one; see [Electron's explanation](https://www.electronjs.org/docs/latest/tutorial/sandbox). Do not apply a hard-coded `/opt/Concord/chrome-sandbox` ownership command to an AppImage mounted at a different path.

### Setup cannot find Python, or engine installation fails

Install Python 3.12 with pip and venv support alongside the system interpreter and reopen Setup. A Python 3.14-only installation will not pass the current check. Review the install output and Terminal. Do not copy another machine's virtual environment; install it on this machine.

### Python path or model does not match the installed engine

For `No module named pip`, update to v2.4.4 or later and retry the installation. Concord checks pip before installing an engine, restores it with Python’s bundled `ensurepip`, and rebuilds its managed environment if repair fails. This preserves the library and model caches. An installation failure now shows guidance for that failure; a valid Python 3.12 installation does not need replacing just because pip is missing.

For an error such as `spawn ./venv/bin/python ENOENT`, open **Pipeline → Setup → Transcription**. Check the installed engine, apply **Use recommended hardware settings**, and review **Model & hardware**. Install or repair the engine if its environment is missing. The wizard saves its managed Python path; a model selection alone is not an engine installation.

### CUDA is unavailable, or a 5090 reports an unsupported architecture

A Ryzen CPU does not prevent NVIDIA acceleration; an integrated Radeon GPU does not provide CUDA. For NVIDIA, check the driver and run the [README's CUDA test](README.md#nvidia--rtx-5090) inside Concord's own Python environment. A successful installer does not by itself prove that the installed PyTorch/CUDA build can transcribe on that GPU.

### No downloads after adding a source

For a new YouTube source, use **Check** or **Full Scan** first to create inventory, then **Start**. Check that the source is enabled, its folder is available, and the daily cap has not been reached. The first Check may take longer because it scans the catalogue.

### The header says Stopped, but work continues

Stop disables scheduled monitoring; it does not cancel existing scans or processing. Inspect Pipeline, Status, and Terminal to see what is still active. Use a background job's Cancel action for that job when available.

### yt-dlp errors or broken YouTube downloads

Use the yt-dlp **recheck** and **update** actions in **Pipeline → Run pipeline**, and review Terminal output. If needed, review cookies under Setup. YouTube changes can affect downloads independently of Concord's app version.

### NeMo messages appear under `[parakeet:err]`

That prefix identifies stderr, which also carries warnings and progress bars. Messages about timestamps, ignored dataloader settings, or tokenization do not by themselves mean transcription failed. Look for chunks continuing to finish, a completed transcript, or an actual traceback/nonzero process exit.

### Semantic search or AI is unavailable

Check the separate AI status dot, provider URL, credentials, and model names in **AI & extras**. Ensure your embedding model returns 1,024 dimensions and indexing has completed. **Words** search and local archive tools remain available without the model server.

### Speaker labels are missing or wrong

Whisper does not provide Concord's speaker diarization. On a supported diarization engine, check the global and source-level switches. Review and correct identities in **Speakers**. Old transcripts may need retranscription to obtain speaker labels; naming a voice alone does not rerun transcription.

## Data and backups

| Data | Default location |
| --- | --- |
| Linux database | `~/.local/share/concord/pipeline.db` |
| Linux managed Python environment | `~/.local/share/concord/venv/` |
| Linux managed yt-dlp | `~/.local/share/concord/bin/yt-dlp` |
| Linux desktop UI/browser state | `~/.config/Concord/` |
| macOS database | `~/Library/Application Support/Concord/pipeline.db` |
| macOS managed yt-dlp | `~/.concord/bin/yt-dlp` |
| Videos and transcripts | The output folders selected in Setup. |
| Document roots | The folders added under Docs. |

Linux data paths honor `XDG_DATA_HOME`. Model libraries also maintain caches outside the source checkout. Application settings, notes, chats, and indexes are stored in the database; referenced documents and external media still need their own backups.

Use **Health → Backup and restore → Create backup** for a consistent database snapshot. Back up video, transcript, and document folders separately. A GitHub/Gitea repository backup or an AppImage download is not a backup of the current live archive.

To restore, choose the `.sqlite` backup and select **Validate and restore…**. Concord validates and stages it, then applies it on restart. It retains a recoverable copy of the previous database. Read the restore confirmation before proceeding, and review saved paths if restoring on a different machine.

AI requests use the configured provider. YouTube downloads/searches and model downloads also communicate with their services. Concord's local storage does not mean every optional connection stays on this computer.
