import Database from "better-sqlite3";
import * as sqliteVec from "sqlite-vec";
import fs from "fs";
import os from "os";
import path from "path";

// Embedding dimension is hardcoded to match Qwen3-Embedding-0.6B (the
// recommended embedding model for Concord). If the user switches to a
// different-dim model (e.g. EmbeddingGemma at 768), the insert path
// throws with a clear "wipe + reindex required" message and they re-run
// the AI page reindex with the new model. We intentionally don't try
// to support mixed dimensions in one table — that gets complicated fast.
export const EMBEDDING_DIM = 1024;

let db: Database.Database | null = null;

function defaultDbPath(): string {
  const home = os.homedir();
  if (process.platform === "darwin") {
    return path.join(home, "Library", "Application Support", "Concord", "pipeline.db");
  }
  if (process.platform === "win32") {
    const appData = process.env.APPDATA || path.join(home, "AppData", "Roaming");
    return path.join(appData, "Concord", "pipeline.db");
  }
  const xdg = process.env.XDG_DATA_HOME || path.join(home, ".local", "share");
  return path.join(xdg, "concord", "pipeline.db");
}

// One-shot migration from the legacy in-repo path. Runs before opening the
// DB, so no connection is held — a plain rename is safe. Sidecar WAL/SHM
// files are migrated alongside if present.
function migrateLegacyDbIfPresent(target: string): void {
  const legacy = path.resolve("./pipeline.db");
  if (legacy === target) return;
  if (fs.existsSync(target)) return;
  if (!fs.existsSync(legacy)) return;

  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.renameSync(legacy, target);
  for (const sidecar of ["-wal", "-shm"]) {
    const src = legacy + sidecar;
    if (fs.existsSync(src)) fs.renameSync(src, target + sidecar);
  }
  console.log(`[db] Migrated legacy ./pipeline.db → ${target}`);
}

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS app_config (
    key        TEXT PRIMARY KEY,
    value      TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS channels (
    id         TEXT PRIMARY KEY,
    name       TEXT NOT NULL,
    url        TEXT NOT NULL UNIQUE,
    enabled    INTEGER NOT NULL DEFAULT 1,
    diarize    INTEGER NOT NULL DEFAULT 1,
    include_shorts INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS video_queue (
    video_id    TEXT NOT NULL,
    channel_id  TEXT NOT NULL,
    title       TEXT NOT NULL,
    url         TEXT NOT NULL,
    duration    REAL,
    is_live     INTEGER DEFAULT 0,
    is_shorts   INTEGER DEFAULT 0,
    upload_date TEXT,
    status      TEXT DEFAULT 'pending',
    video_path  TEXT,
    md_path     TEXT,
    word_count  INTEGER DEFAULT 0,
    error       TEXT,
    retries     INTEGER DEFAULT 0,
    created_at  TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at  TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (video_id, channel_id)
  );

  CREATE INDEX IF NOT EXISTS idx_queue_status  ON video_queue(channel_id, status);
  CREATE INDEX IF NOT EXISTS idx_queue_date    ON video_queue(channel_id, upload_date);
  CREATE INDEX IF NOT EXISTS idx_channels_enabled ON channels(enabled);

  CREATE TABLE IF NOT EXISTS transcript_index (
    video_id       TEXT NOT NULL,
    channel_id     TEXT NOT NULL,
    md_path        TEXT NOT NULL,
    md_mtime_ms    REAL NOT NULL,
    segment_count  INTEGER NOT NULL DEFAULT 0,
    indexed_at     TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (video_id, channel_id)
  );

  CREATE VIRTUAL TABLE IF NOT EXISTS transcript_segments_fts USING fts5(
    video_id UNINDEXED,
    channel_id UNINDEXED,
    segment_index UNINDEXED,
    start_seconds UNINDEXED,
    end_seconds UNINDEXED,
    speaker UNINDEXED,
    text,
    tokenize = 'unicode61'
  );

  CREATE TABLE IF NOT EXISTS transcript_clips (
    id            TEXT PRIMARY KEY,
    video_id      TEXT NOT NULL,
    channel_id    TEXT NOT NULL,
    title         TEXT NOT NULL,
    channel_name  TEXT,
    upload_date   TEXT,
    start_seconds REAL NOT NULL,
    end_seconds   REAL NOT NULL,
    quote         TEXT NOT NULL,
    note          TEXT,
    created_at    TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_clips_video ON transcript_clips(video_id, channel_id);
  CREATE INDEX IF NOT EXISTS idx_clips_created ON transcript_clips(created_at);

  CREATE TABLE IF NOT EXISTS clip_tags (
    clip_id    TEXT NOT NULL REFERENCES transcript_clips(id) ON DELETE CASCADE,
    tag        TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (clip_id, tag)
  );

  CREATE INDEX IF NOT EXISTS idx_clip_tags_tag ON clip_tags(tag);

  CREATE TABLE IF NOT EXISTS clip_links (
    from_clip_id TEXT NOT NULL REFERENCES transcript_clips(id) ON DELETE CASCADE,
    to_clip_id   TEXT NOT NULL REFERENCES transcript_clips(id) ON DELETE CASCADE,
    kind         TEXT NOT NULL,
    note         TEXT,
    created_at   TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (from_clip_id, to_clip_id, kind)
  );

  CREATE INDEX IF NOT EXISTS idx_clip_links_to ON clip_links(to_clip_id);

  CREATE TABLE IF NOT EXISTS clip_map_layouts (
    map_key    TEXT NOT NULL,
    node_id    TEXT NOT NULL,
    x          REAL NOT NULL,
    y          REAL NOT NULL,
    width      REAL NOT NULL,
    height     REAL NOT NULL,
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (map_key, node_id)
  );

  -- ---- Multi-anchor notes ----
  --
  -- Conceptual model: a "note" (stored in transcript_clips for legacy ID
  -- continuity) is the user's first-class research entity. Each note can
  -- have many (video, timestamp range) anchors as evidence. Phase 1
  -- backfills every existing clip with exactly one anchor (ordinal=1)
  -- mirroring the single-anchor columns on transcript_clips. Subsequent
  -- phases shift reads/writes to source anchors from this table; the
  -- legacy columns stay populated for back-compat.
  CREATE TABLE IF NOT EXISTS note_anchors (
    clip_id        TEXT NOT NULL REFERENCES transcript_clips(id) ON DELETE CASCADE,
    ordinal        INTEGER NOT NULL,
    video_id       TEXT NOT NULL,
    channel_id     TEXT NOT NULL,
    start_seconds  REAL,
    end_seconds    REAL,
    excerpt        TEXT,
    created_at     TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (clip_id, ordinal)
  );

  CREATE INDEX IF NOT EXISTS idx_note_anchors_video ON note_anchors(video_id, channel_id);

  -- ---- AI chat persistence ----
  --
  -- Conversations group user/assistant turns. Each assistant message
  -- carries the K retrieved sources (segments) it was grounded on, so the
  -- citation chips ([1], [2], ...) in the message body can resolve back
  -- to clickable VideoDrawer entries even after refresh.
  CREATE TABLE IF NOT EXISTS chat_conversations (
    id          TEXT PRIMARY KEY,
    title       TEXT,
    pinned      INTEGER NOT NULL DEFAULT 0,
    created_at  TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS chat_messages (
    id              TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL REFERENCES chat_conversations(id) ON DELETE CASCADE,
    role            TEXT NOT NULL,            -- 'user' | 'assistant'
    content         TEXT NOT NULL,
    model           TEXT,                     -- chat model used (assistant only)
    is_starred      INTEGER NOT NULL DEFAULT 0,
    created_at      TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_chat_messages_conv ON chat_messages(conversation_id, created_at);

  CREATE TABLE IF NOT EXISTS chat_message_sources (
    message_id     TEXT NOT NULL REFERENCES chat_messages(id) ON DELETE CASCADE,
    source_index   INTEGER NOT NULL,         -- 1-based, matches [N] in body
    video_id       TEXT NOT NULL,
    channel_id     TEXT NOT NULL,
    segment_index  INTEGER,
    start_seconds  REAL,
    end_seconds    REAL,
    speaker        TEXT,
    excerpt        TEXT,
    score          REAL,
    PRIMARY KEY (message_id, source_index)
  );

  -- ---- Voice profiles (cross-video speaker identity) ----
  --
  -- Each row = one named voice (e.g. "Joe Rogan"). Stays stable across
  -- the entire archive; per-video local labels (S0, S1, ...) get mapped
  -- to these via video_speaker_assignments below.
  CREATE TABLE IF NOT EXISTS speakers (
    id            TEXT PRIMARY KEY,
    name          TEXT NOT NULL,
    display_color TEXT,
    notes         TEXT,
    is_noise      INTEGER NOT NULL DEFAULT 0,
    created_at    TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- Aggregated voice fingerprint per speaker. Updated incrementally each
  -- time the user labels a new video-local centroid as this speaker —
  -- count-weighted moving average so the centroid converges as more
  -- samples come in.
  CREATE TABLE IF NOT EXISTS speaker_embeddings (
    speaker_id   TEXT PRIMARY KEY,
    embedding    BLOB NOT NULL,
    sample_count INTEGER NOT NULL DEFAULT 1,
    updated_at   TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (speaker_id) REFERENCES speakers(id) ON DELETE CASCADE
  );

  -- For each (video, local_speaker) pair, the per-video centroid embedding
  -- + reference to a global speaker (if matched/labeled). speaker_id NULL
  -- means "unidentified — needs labeling." sample_start/end point to the
  -- longest turn for this local speaker in this video, used for the
  -- "play sample" UX.
  CREATE TABLE IF NOT EXISTS video_speaker_assignments (
    video_id        TEXT NOT NULL,
    channel_id      TEXT NOT NULL,
    local_speaker   TEXT NOT NULL,
    speaker_id      TEXT,
    centroid        BLOB NOT NULL,
    confidence      REAL,
    sample_start    REAL,
    sample_end      REAL,
    airtime_seconds REAL NOT NULL DEFAULT 0,
    updated_at      TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (video_id, channel_id, local_speaker),
    FOREIGN KEY (speaker_id) REFERENCES speakers(id) ON DELETE SET NULL
  );

  CREATE INDEX IF NOT EXISTS idx_vsa_speaker_id ON video_speaker_assignments(speaker_id);
  CREATE INDEX IF NOT EXISTS idx_vsa_video ON video_speaker_assignments(video_id, channel_id);

  -- ---- YouTube Discover ----
  --
  -- A "watcher" is a saved search group: one or more title phrase
  -- variants ("with John Smith", "interview with John Smith", ...) plus
  -- optional channel allow/block lists. Polled on a configurable cadence
  -- via YouTube Data API v3 search.list.
  --
  -- Hits land in youtube_inbox for review unless the watcher has
  -- auto_queue=1, in which case they go straight into video_queue.
  CREATE TABLE IF NOT EXISTS youtube_watchers (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    label               TEXT NOT NULL,
    phrase_variants     TEXT NOT NULL,
    allowed_channels    TEXT,
    blocked_channels    TEXT,
    enabled             INTEGER NOT NULL DEFAULT 1,
    auto_queue          INTEGER NOT NULL DEFAULT 0,
    poll_interval_hours INTEGER NOT NULL DEFAULT 24,
    last_polled_at      TEXT,
    last_error          TEXT,
    created_at          TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at          TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- One row per (watcher, video) hit. Dedupes within a watcher so
  -- repeated polls don't re-surface the same video. Cross-watcher
  -- duplicates are fine — different watchers may legitimately match the
  -- same video for different reasons.
  CREATE TABLE IF NOT EXISTS youtube_inbox (
    watcher_id      INTEGER NOT NULL REFERENCES youtube_watchers(id) ON DELETE CASCADE,
    video_id        TEXT NOT NULL,
    channel_id      TEXT NOT NULL,
    channel_name    TEXT,
    title           TEXT NOT NULL,
    description     TEXT,
    thumbnail_url   TEXT,
    published_at    TEXT,
    found_at        TEXT NOT NULL DEFAULT (datetime('now')),
    status          TEXT NOT NULL DEFAULT 'new',
    PRIMARY KEY (watcher_id, video_id)
  );

  CREATE INDEX IF NOT EXISTS idx_yt_inbox_status ON youtube_inbox(status, found_at);
  CREATE INDEX IF NOT EXISTS idx_yt_inbox_video  ON youtube_inbox(video_id);
`;


// StoredChannel interface + channel CRUD live in db-channels.ts; re-exported below.

export function getDb(dbPath?: string): Database.Database {
  if (!db) {
    const resolvedPath = dbPath ? path.resolve(dbPath) : defaultDbPath();
    if (!dbPath) migrateLegacyDbIfPresent(resolvedPath);
    fs.mkdirSync(path.dirname(resolvedPath), { recursive: true });
    db = new Database(resolvedPath);
    db.pragma("journal_mode = WAL");
    db.pragma("busy_timeout = 5000");
    db.pragma("foreign_keys = ON");

    // Load sqlite-vec extension (vector search). Must happen BEFORE we
    // create the vec_segments virtual table or run any migration that
    // touches it. The npm package ships prebuilt loadable libs for
    // darwin-arm64 / darwin-x64 / linux-x64 / linux-arm64 / windows-x64.
    //
    // We bypass sqlite-vec's bundled `load(db)` because it uses
    // `import.meta.resolve()` to locate the `.dylib`, which inside a
    // packaged Electron app returns a path inside `app.asar/`. Native
    // libraries can't be dlopen'd from inside asar — they have to be
    // loaded from `app.asar.unpacked/` (electron-builder's asarUnpack
    // config copies them there at build time). The CJS `require.resolve`
    // path Electron uses for require IS asar-aware, but ESM
    // `import.meta.resolve` isn't yet, so the path comes back wrong.
    // Fix: take whatever path sqlite-vec computes, swap the asar segment
    // for asar.unpacked when it points inside the bundle, then call
    // loadExtension directly.
    const vecPath = sqliteVec.getLoadablePath();
    const fixedVecPath = vecPath.includes("/app.asar/")
      ? vecPath.replace("/app.asar/", "/app.asar.unpacked/")
      : vecPath;
    db.loadExtension(fixedVecPath);

    db.exec(SCHEMA);

    // The vec0 virtual table for embeddings. Auxiliary columns (`+`)
    // are stored alongside the vector and queryable in WHERE clauses
    // without leaving the index. vec0 in 0.1.x supports TEXT / INTEGER /
    // FLOAT / DOUBLE / BLOB only — REAL throws a misleading "chunk_size"
    // error, so seconds use FLOAT. Distance is L2 by default; we
    // normalize vectors at insert/query time so L2 ranks identically
    // to cosine, then convert distance back to similarity for display.
    db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS vec_segments USING vec0(
        embedding float[${EMBEDDING_DIM}],
        +video_id TEXT,
        +channel_id TEXT,
        +segment_index INTEGER,
        +model TEXT,
        +text TEXT,
        +start_seconds FLOAT,
        +end_seconds FLOAT,
        +speaker TEXT
      )
    `);

    // Markdown doc chunks live in their own vec0 table so the schema
    // can carry doc-shaped metadata (heading path, character range)
    // without polluting vec_segments. AI retrieval queries both
    // tables and merges by similarity.
    db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS vec_docs USING vec0(
        embedding float[${EMBEDDING_DIM}],
        +document_id TEXT,
        +chunk_index INTEGER,
        +model TEXT,
        +text TEXT,
        +heading_path TEXT,
        +start_char INTEGER,
        +end_char INTEGER
      )
    `);

    runMigrations(db);
    console.log(`[db] SQLite ready: ${resolvedPath} (sqlite-vec loaded, dim=${EMBEDDING_DIM})`);
  }
  return db;
}

/**
 * Idempotent column adds for existing databases. SQLite has no
 * `ALTER TABLE ... ADD COLUMN IF NOT EXISTS`, so we read pragma_table_info
 * and skip columns that already exist.
 */
/** Local copy of normalizeVector — only used by the one-shot embedding
 *  migration below. Lives here rather than importing from db-embeddings
 *  to avoid the circular dependency through the barrel re-export. */
function normalizeVectorLocal(vec: Float32Array): Float32Array {
  let norm = 0;
  for (let i = 0; i < vec.length; i++) norm += vec[i] * vec[i];
  norm = Math.sqrt(norm);
  if (norm === 0) return vec;
  const out = new Float32Array(vec.length);
  for (let i = 0; i < vec.length; i++) out[i] = vec[i] / norm;
  return out;
}

function runMigrations(database: Database.Database) {
  const ensureColumn = (table: string, column: string, definition: string) => {
    const cols = database.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
    if (!cols.some(c => c.name === column)) {
      database.prepare(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`).run();
    }
  };
  ensureColumn("video_queue", "notes", "TEXT");
  ensureColumn("video_queue", "ai_summary", "TEXT");
  ensureColumn("video_queue", "ai_summary_model", "TEXT");
  ensureColumn("channels", "diarize", "INTEGER NOT NULL DEFAULT 1");
  ensureColumn("channels", "include_shorts", "INTEGER NOT NULL DEFAULT 0");
  ensureColumn("speakers", "is_noise", "INTEGER NOT NULL DEFAULT 0");
  // Optional sidecar path: for source files whose codec the browser may not
  // decode (Ogg with Speex/FLAC, etc.), we transcode to .m4a at ingestion
  // time. The /stream endpoint prefers this path so playback is universal.
  // NULL = use video_path directly (the original is browser-compatible).
  ensureColumn("video_queue", "playback_path", "TEXT");

  // User-starred videos. Lets the user mark "this one's crucial"
  // independent of system status — surfaces in the Library with a
  // dedicated filter chip.
  ensureColumn("video_queue", "starred", "INTEGER NOT NULL DEFAULT 0");

  // Personal / work category. A viewing toggle in the header filters
  // every list (Library, Watchers, Inbox, ...) by category, so the
  // user can keep work-research and personal-archive views cleanly
  // separated. Stored values are 'personal' | 'work'; the "both"
  // toggle state means "no filter". Existing rows default to
  // 'personal' (back-compat — the personal archive predates this
  // feature).
  ensureColumn("channels", "category", "TEXT NOT NULL DEFAULT 'personal'");
  ensureColumn("video_queue", "category", "TEXT NOT NULL DEFAULT 'personal'");
  ensureColumn("youtube_watchers", "category", "TEXT NOT NULL DEFAULT 'personal'");

  // ---- Markdown docs as a first-class content type ----
  //
  // documents rows mirror files under docs.rootFolder. id is derived
  // from the relative path so it survives content edits (and so
  // note_anchors can hold a stable doc_id). Renames look like a remove
  // + insert; that's fine for v1.
  //
  // starred + category make docs filterable the same way videos are.
  // content_hash + mtime_ms power incremental re-indexing — when a
  // file's hash changes, the indexer re-chunks + re-embeds just that
  // doc instead of the whole tree.
  database.exec(`
    CREATE TABLE IF NOT EXISTS documents (
      id            TEXT PRIMARY KEY,
      rel_path      TEXT NOT NULL UNIQUE,
      title         TEXT NOT NULL,
      starred       INTEGER NOT NULL DEFAULT 0,
      category      TEXT NOT NULL DEFAULT 'personal',
      content_hash  TEXT NOT NULL,
      bytes         INTEGER NOT NULL,
      mtime_ms      REAL NOT NULL,
      created_at    TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_documents_starred ON documents(starred);
    CREATE INDEX IF NOT EXISTS idx_documents_category ON documents(category);
  `);

  // note_anchors gains optional doc-source columns so a single anchor
  // can point at either a video timestamp or a doc character range.
  // The video_id/channel_id columns were NOT NULL in the original
  // schema; we relax them below so a doc-only anchor is legal.
  ensureColumn("note_anchors", "document_id", "TEXT REFERENCES documents(id) ON DELETE CASCADE");
  ensureColumn("note_anchors", "doc_start_char", "INTEGER");
  ensureColumn("note_anchors", "doc_end_char", "INTEGER");

  // chat_message_sources gains a discriminator + the same doc-source
  // fields used elsewhere. Old persisted sources read back as source =
  // "video" (the default applied on the read side when NULL).
  ensureColumn("chat_message_sources", "source", "TEXT");
  ensureColumn("chat_message_sources", "document_id", "TEXT");
  ensureColumn("chat_message_sources", "doc_chunk_index", "INTEGER");
  ensureColumn("chat_message_sources", "doc_start_char", "INTEGER");
  ensureColumn("chat_message_sources", "doc_end_char", "INTEGER");
  ensureColumn("chat_message_sources", "doc_heading_path", "TEXT");

  // Recreate note_anchors with nullable video_id/channel_id if the
  // original NOT NULL is still in place. Detect by reading
  // pragma_table_info — if either column reports notnull=1, rebuild.
  relaxNoteAnchorVideoNullability(database);

  // Per-link handle side ("left" | "right" | "top" | "bottom"). NULL = the
  // Map page falls back to right→left, matching the legacy fixed-side
  // behavior. The user picks sides explicitly by dragging from one handle
  // to another (loose connection mode), so each link can attach where the
  // user dropped it instead of being forced into a single LTR flow.
  ensureColumn("clip_links", "from_handle", "TEXT");
  ensureColumn("clip_links", "to_handle", "TEXT");

  // Anchor ordinal — which appearance of the note the link attaches to.
  // Multi-anchor notes appear as multiple rows in a video container;
  // without ordinal in the PK, two different anchors of the same note
  // can't both link to the same target with the same kind (they'd
  // collide on PK). 0 = no specific anchor (Cards mode / standalone).
  ensureColumn("clip_links", "from_ordinal", "INTEGER NOT NULL DEFAULT 0");
  ensureColumn("clip_links", "to_ordinal", "INTEGER NOT NULL DEFAULT 0");

  // Promote the ordinal columns into the PK if they aren't already.
  // SQLite can't ALTER a primary key in place — the only path is
  // recreate-the-table. Detect by reading pragma_table_info: if
  // from_ordinal isn't marked pk > 0, the old (from, to, kind) PK is
  // still in place. Existing rows are preserved (their NULL ordinals
  // are coerced to 0 by the column default).
  const linkCols = database
    .prepare(`PRAGMA table_info(clip_links)`)
    .all() as { name: string; pk: number }[];
  const ordinalInPk = linkCols.some(c => c.name === "from_ordinal" && c.pk > 0);
  if (!ordinalInPk) {
    database.exec(`
      CREATE TABLE clip_links_new (
        from_clip_id TEXT NOT NULL REFERENCES transcript_clips(id) ON DELETE CASCADE,
        to_clip_id   TEXT NOT NULL REFERENCES transcript_clips(id) ON DELETE CASCADE,
        kind         TEXT NOT NULL,
        from_ordinal INTEGER NOT NULL DEFAULT 0,
        to_ordinal   INTEGER NOT NULL DEFAULT 0,
        from_handle  TEXT,
        to_handle    TEXT,
        note         TEXT,
        created_at   TEXT NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY (from_clip_id, to_clip_id, kind, from_ordinal, to_ordinal)
      );
      INSERT INTO clip_links_new
        (from_clip_id, to_clip_id, kind, from_ordinal, to_ordinal,
         from_handle, to_handle, note, created_at)
        SELECT
          from_clip_id, to_clip_id, kind,
          COALESCE(from_ordinal, 0), COALESCE(to_ordinal, 0),
          from_handle, to_handle, note, created_at
        FROM clip_links;
      DROP TABLE clip_links;
      ALTER TABLE clip_links_new RENAME TO clip_links;
      CREATE INDEX IF NOT EXISTS idx_clip_links_to ON clip_links(to_clip_id);
    `);
  }

  // Renamed link kind: same_scripture → same_topic. Migrate any existing rows.
  database
    .prepare("UPDATE clip_links SET kind = 'same_topic' WHERE kind = 'same_scripture'")
    .run();

  // Backfill note_anchors from existing transcript_clips. Each clip gets
  // exactly one anchor (ordinal=1) mirroring its legacy single-anchor
  // columns. Idempotent — only inserts for clips that don't already have
  // any anchors. Skips standalone notes (NULL video_id/channel_id) since
  // they legitimately have no anchors and the note_anchors table NOT-NULLs
  // both columns.
  const backfilledAnchors = database.prepare(`
    INSERT INTO note_anchors (clip_id, ordinal, video_id, channel_id, start_seconds, end_seconds, excerpt)
    SELECT id, 1, video_id, channel_id, start_seconds, end_seconds, quote
    FROM transcript_clips
    WHERE id NOT IN (SELECT clip_id FROM note_anchors)
      AND video_id IS NOT NULL
      AND channel_id IS NOT NULL
  `).run();
  if (backfilledAnchors.changes > 0) {
    console.log(`[db] Backfilled ${backfilledAnchors.changes} note_anchors from existing clips`);
  }

  // Relax NOT NULL on transcript_clips' legacy single-anchor columns so
  // standalone "just a thought" notes (zero anchors) can be created. SQLite
  // can't ALTER COLUMN DROP NOT NULL, so the only path is recreate-the-table.
  // Idempotent: detected by reading pragma_table_info; foreign keys from
  // clip_tags / clip_links re-attach by name after RENAME, so existing tag
  // and link data survives untouched.
  relaxClipAnchorNotNull(database);

  // Add `speaker` column to transcript_segments_fts. FTS5 has no
  // ALTER TABLE — the only path is DROP + CREATE. Existing transcripts on
  // disk get re-indexed automatically on the next refreshTranscriptSearchIndex
  // call (the index is fully derivable from the .json/.md files).
  const ftsCols = database.prepare(`PRAGMA table_info(transcript_segments_fts)`).all() as { name: string }[];
  if (ftsCols.length > 0 && !ftsCols.some(c => c.name === "speaker")) {
    database.exec("DROP TABLE transcript_segments_fts");
    database.exec(`
      CREATE VIRTUAL TABLE transcript_segments_fts USING fts5(
        video_id UNINDEXED,
        channel_id UNINDEXED,
        segment_index UNINDEXED,
        start_seconds UNINDEXED,
        end_seconds UNINDEXED,
        speaker UNINDEXED,
        text,
        tokenize = 'unicode61'
      )
    `);
    // transcript_index uses md_mtime to skip "already indexed" files. Wipe it
    // so the next refresh re-indexes everything into the new FTS schema.
    database.exec("DELETE FROM transcript_index");
    console.log("[db] Migrated transcript_segments_fts to add speaker column (re-index on next search)");
  }

  // Migrate from the legacy `transcript_segment_embeddings` SQL table to
  // the new `vec_segments` vec0 virtual table (sqlite-vec). Pure-JS cosine
  // doesn't scale past ~50K segments; vec0 is built for this. One-shot
  // copy + drop, idempotent (the source table won't exist after the first
  // run). Skips rows whose embedding dim doesn't match EMBEDDING_DIM —
  // those would fail at insert anyway and would just bloat the new table.
  const oldExists = database.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name='transcript_segment_embeddings'",
  ).get();
  if (oldExists) {
    type LegacyRow = {
      video_id: string;
      channel_id: string;
      segment_index: number;
      model: string;
      embedding: Buffer;
      text: string;
      start_seconds: number;
      end_seconds: number;
      speaker: string | null;
    };
    const rows = database.prepare(`
      SELECT video_id, channel_id, segment_index, model, embedding, text,
             start_seconds, end_seconds, speaker
      FROM transcript_segment_embeddings
    `).all() as LegacyRow[];

    let migrated = 0;
    let skippedDim = 0;
    if (rows.length > 0) {
      const insert = database.prepare(`
        INSERT INTO vec_segments
          (embedding, video_id, channel_id, segment_index, model, text, start_seconds, end_seconds, speaker)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      const tx = database.transaction(() => {
        for (const row of rows) {
          const dim = row.embedding.byteLength / 4;
          if (dim !== EMBEDDING_DIM) {
            skippedDim++;
            continue;
          }
          // Normalize during migration — old embeddings predate the
          // unit-norm-at-insert convention. vec0 uses L2 distance, which
          // ranks identically to cosine only for unit-norm vectors.
          const oldVec = new Float32Array(
            row.embedding.buffer,
            row.embedding.byteOffset,
            row.embedding.byteLength / 4,
          );
          const normalized = normalizeVectorLocal(oldVec);
          insert.run(
            Buffer.from(normalized.buffer, normalized.byteOffset, normalized.byteLength),
            row.video_id, row.channel_id,
            BigInt(row.segment_index), // INTEGER aux column — see note in replaceVideoEmbeddings
            row.model,
            row.text, row.start_seconds, row.end_seconds, row.speaker,
          );
          migrated++;
        }
      });
      tx();
    }

    database.exec("DROP TABLE transcript_segment_embeddings");
    console.log(
      `[db] Migrated ${migrated} embeddings → sqlite-vec vec_segments`
      + (skippedDim > 0 ? ` (skipped ${skippedDim} with mismatched dim — re-embed via AI page reindex)` : ""),
    );
  }
}

function relaxClipAnchorNotNull(database: Database.Database): void {
  const cols = database.prepare(`PRAGMA table_info(transcript_clips)`).all() as Array<{ name: string; notnull: number }>;
  const videoIdCol = cols.find((c) => c.name === "video_id");
  // Skip when the table is already relaxed, or when the column simply
  // doesn't exist (shouldn't happen, but defensive against future schema
  // drift).
  if (!videoIdCol || videoIdCol.notnull === 0) return;

  console.log("[db] Relaxing transcript_clips NOT NULL constraints (enables standalone notes)…");
  database.pragma("foreign_keys = OFF");
  try {
    database.transaction(() => {
      database.exec(`
        CREATE TABLE transcript_clips_new (
          id            TEXT PRIMARY KEY,
          video_id      TEXT,
          channel_id    TEXT,
          title         TEXT NOT NULL,
          channel_name  TEXT,
          upload_date   TEXT,
          start_seconds REAL,
          end_seconds   REAL,
          quote         TEXT,
          note          TEXT,
          created_at    TEXT NOT NULL DEFAULT (datetime('now')),
          updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
        );
        INSERT INTO transcript_clips_new
          (id, video_id, channel_id, title, channel_name, upload_date,
           start_seconds, end_seconds, quote, note, created_at, updated_at)
        SELECT
          id, video_id, channel_id, title, channel_name, upload_date,
          start_seconds, end_seconds, quote, note, created_at, updated_at
        FROM transcript_clips;
        DROP TABLE transcript_clips;
        ALTER TABLE transcript_clips_new RENAME TO transcript_clips;
        CREATE INDEX IF NOT EXISTS idx_clips_video ON transcript_clips(video_id, channel_id);
        CREATE INDEX IF NOT EXISTS idx_clips_created ON transcript_clips(created_at);
      `);
    })();
    console.log("[db] transcript_clips relaxed — standalone notes are now allowed.");
  } finally {
    database.pragma("foreign_keys = ON");
  }
}

/** Mirror of relaxClipAnchorNotNull for note_anchors — original schema
 *  marked video_id + channel_id as NOT NULL, but anchors now also point
 *  at documents (mutually exclusive per row). Rebuild the table once
 *  to relax both columns; idempotent thereafter. */
function relaxNoteAnchorVideoNullability(database: Database.Database): void {
  const cols = database.prepare(`PRAGMA table_info(note_anchors)`).all() as Array<{ name: string; notnull: number }>;
  const videoIdCol = cols.find((c) => c.name === "video_id");
  if (!videoIdCol || videoIdCol.notnull === 0) return;

  console.log("[db] Relaxing note_anchors NOT NULL constraints (enables doc-anchored notes)…");
  database.pragma("foreign_keys = OFF");
  try {
    database.transaction(() => {
      database.exec(`
        CREATE TABLE note_anchors_new (
          clip_id        TEXT NOT NULL REFERENCES transcript_clips(id) ON DELETE CASCADE,
          ordinal        INTEGER NOT NULL,
          video_id       TEXT,
          channel_id     TEXT,
          start_seconds  REAL,
          end_seconds    REAL,
          excerpt        TEXT,
          document_id    TEXT REFERENCES documents(id) ON DELETE CASCADE,
          doc_start_char INTEGER,
          doc_end_char   INTEGER,
          created_at     TEXT NOT NULL DEFAULT (datetime('now')),
          PRIMARY KEY (clip_id, ordinal)
        );
        INSERT INTO note_anchors_new
          (clip_id, ordinal, video_id, channel_id, start_seconds, end_seconds,
           excerpt, document_id, doc_start_char, doc_end_char, created_at)
        SELECT
          clip_id, ordinal, video_id, channel_id, start_seconds, end_seconds,
          excerpt, document_id, doc_start_char, doc_end_char, created_at
        FROM note_anchors;
        DROP TABLE note_anchors;
        ALTER TABLE note_anchors_new RENAME TO note_anchors;
        CREATE INDEX IF NOT EXISTS idx_note_anchors_video ON note_anchors(video_id, channel_id);
        CREATE INDEX IF NOT EXISTS idx_note_anchors_document ON note_anchors(document_id);
      `);
    })();
    console.log("[db] note_anchors relaxed — doc-anchored notes are now allowed.");
  } finally {
    database.pragma("foreign_keys = ON");
  }
}

// ---- Pipeline config operations ----

export function getConfigValues(): Record<string, string> {
  const rows = getDb().prepare("SELECT key, value FROM app_config").all() as { key: string; value: string }[];
  return Object.fromEntries(rows.map(row => [row.key, row.value]));
}

export function setConfigValues(values: Record<string, string | number | boolean | null>): void {
  const setValue = getDb().prepare(`
    INSERT INTO app_config (key, value, updated_at)
    VALUES (?, ?, datetime('now'))
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')
  `);

  const tx = getDb().transaction(() => {
    for (const [key, value] of Object.entries(values)) {
      if (value === undefined) continue;
      setValue.run(key, value === null ? "" : String(value));
    }
  });

  tx();
}

// ---- Daily download counter ----
//
// Stored as two app_config rows: `dailyDownload.date` (YYYY-MM-DD local
// timezone) and `dailyDownload.count` (stringified integer). If the
// stored date isn't today's local date, the count is stale and reads
// as 0 — equivalent to a midnight reset, no scheduler needed.

function todayLocalDateString(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${dd}`;
}

export function getTodayDownloadCount(): number {
  const cfg = getConfigValues();
  if (cfg["dailyDownload.date"] !== todayLocalDateString()) return 0;
  const n = parseInt(cfg["dailyDownload.count"] || "0", 10);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

export function incrementTodayDownloadCount(): number {
  const next = getTodayDownloadCount() + 1;
  setConfigValues({
    "dailyDownload.date": todayLocalDateString(),
    "dailyDownload.count": String(next),
  });
  return next;
}

export function resetTodayDownloadCount(): void {
  setConfigValues({
    "dailyDownload.date": todayLocalDateString(),
    "dailyDownload.count": "0",
  });
}

// Voice profiles + speaker embeddings + video_speaker_assignments live in
// db-speakers.ts (big domain — its own file).
// AI chat persistence lives in db-chat.ts.
// Archive status snapshot lives in db-status.ts.
// All three re-exported via the barrel below so callers keep using
// `import { ... } from "./db"` unchanged.

export function closeDb(): void {
  if (db) { db.close(); db = null; console.log("[db] SQLite closed"); }
}

// ---------------------------------------------------------------
// Domain modules — keep db.ts focused on the singleton + schema +
// migrations + the few cross-cutting types. Domain logic lives in
// db-<area>.ts siblings and is re-exported here so callers keep
// using `import { ... } from "./db"` unchanged.
// ---------------------------------------------------------------

export * from "./db-channels";
export * from "./db-chat";
export * from "./db-embeddings";
export * from "./db-notes";
export * from "./db-queue";
export * from "./db-speakers";
export * from "./db-status";
