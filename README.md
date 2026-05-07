# YouTube Ripper

Local YouTube download + transcription pipeline. Vite + React frontend with a Node/TypeScript backend, SQLite (`pipeline.db`) for job tracking, and a Python venv for transcription tooling.

## Layout

```
client/         — Vite + React frontend
server/         — Node/TypeScript backend
shared/         — Shared types/utilities between client and server
pipeline.db     — SQLite job database (tracked in git as backup)
drizzle.config.ts — Drizzle ORM config
package.json    — Node dependencies
```

## What's NOT in this repo (gitignored)

- `node_modules/` — `npm install` to recreate
- `venv/` — Python virtual env, recreate locally
- `dist/`, `server/public/` — built output
- `downloads/`, `temp/`, `transcripts/`, `saved_videos/`, `youtube-dl-cache/` — working folders, content regenerable
- All media files (`.mp4`, `.mp3`, `.m4a`, `.wav`, `.webm`, `.mkv`)
- SQLite transient files (`.db-shm`, `.db-wal`) — `pipeline.db` itself is tracked

## Setup

```sh
npm install
python -m venv venv && source venv/bin/activate && pip install -r requirements.txt   # if requirements.txt exists
```

## Running

```sh
npm run dev
# or
./start-server.bat   # Windows
```

## Notes

- `pipeline.db` is committed as a backup of job state. Before committing major DB changes, run a SQLite WAL checkpoint (`sqlite3 pipeline.db "PRAGMA wal_checkpoint(TRUNCATE);"`) to flush the WAL into the main DB so the committed `.db` reflects current state.
