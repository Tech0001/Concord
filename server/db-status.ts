import {
  getDb,
  getChannels,
  getTranscriptSearchIndexStats,
  getEmbeddingStats,
} from "./db";

// ---------------------------------------------------------------
// Archive status snapshot — powers the Status page.
//
// One pure-aggregate function plus the response shape. Every query is
// indexed or operates on a small table (channels, speakers); total wall
// time is single-digit milliseconds even with a few thousand videos.
// ---------------------------------------------------------------

export interface ChannelRollup {
  id: string;
  name: string;
  enabled: boolean;
  diarize: boolean;
  includeShorts: boolean;
  totalVideos: number;
  completedVideos: number;
  pendingVideos: number;
  failedVideos: number;
  embeddedVideos: number;
  summarizedVideos: number;
  diarizedVideos: number;
}

export interface ArchiveStatus {
  archive: {
    channelCount: number;
    enabledChannelCount: number;
    totalVideos: number;
    completedVideos: number;
    pendingVideos: number;
    failedVideos: number;
    inflightVideos: number;
    shortsVideos: number;
    totalDurationSeconds: number;
    totalWordCount: number;
  };
  coverage: {
    transcripts: { covered: number; total: number };
    diarization: { covered: number; applicable: number };
    aiSummaries: { covered: number; total: number };
    fts: { files: number; segments: number };
    embeddings: {
      activeModel: string | null;
      models: { model: string; videos: number; segments: number }[];
      activeModelCovered: number;
      activeModelTotal: number;
    };
  };
  speakers: {
    total: number;
    labeled: number;
    noise: number;
    videosWithDiarization: number;
    unidentifiedClusters: number;
  };
  channels: ChannelRollup[];
  recentFailures: {
    videoId: string;
    channelId: string;
    title: string;
    status: string;
    error: string | null;
    updatedAt: string;
  }[];
}

/** One-shot archive snapshot for the Status dashboard. Each piece is a
 *  cheap aggregate query — total wall time on a typical archive is a few
 *  ms even without indexes since the tables are tiny relative to actual
 *  user data (videos, segments). */
export function getArchiveStatus(activeEmbedModel: string | null): ArchiveStatus {
  const d = getDb();
  const channels = getChannels();

  // Per-status totals across the whole queue.
  const statusRows = d.prepare(
    "SELECT status, COUNT(*) as cnt FROM video_queue GROUP BY status"
  ).all() as { status: string; cnt: number }[];
  const byStatus: Record<string, number> = {};
  for (const r of statusRows) byStatus[r.status] = r.cnt;
  const completedVideos = byStatus.complete || 0;
  const pendingVideos = byStatus.pending || 0;
  const failedVideos = byStatus.failed || 0;
  const totalVideos = Object.values(byStatus).reduce((s, n) => s + n, 0);
  const inflightVideos = totalVideos - completedVideos - pendingVideos - failedVideos;

  const shortsRow = d.prepare(
    "SELECT COUNT(*) as cnt FROM video_queue WHERE is_shorts = 1"
  ).get() as { cnt: number };

  const totalsRow = d.prepare(`
    SELECT
      COALESCE(SUM(CASE WHEN status='complete' THEN duration   END), 0) as duration_total,
      COALESCE(SUM(CASE WHEN status='complete' THEN word_count END), 0) as word_total
    FROM video_queue
  `).get() as { duration_total: number; word_total: number };

  // Coverage: transcripts (markdown file present on a complete row).
  const transcriptsCovered = (d.prepare(`
    SELECT COUNT(*) as cnt FROM video_queue
    WHERE status = 'complete' AND md_path IS NOT NULL AND md_path <> ''
  `).get() as { cnt: number }).cnt;

  // Coverage: diarization (any speaker assignments stored for the video).
  const diarizedCovered = (d.prepare(`
    SELECT COUNT(DISTINCT video_id || ':' || channel_id) as cnt
    FROM video_speaker_assignments
  `).get() as { cnt: number }).cnt;

  // Diarization "applicable" = complete videos in channels with diarize on.
  // Channels added through the UI default to diarize=1 so the rollup matches
  // user expectation (the toggle off case is opt-out for known mono-speaker
  // content). Compare against the channels table directly so videos whose
  // channel was deleted don't inflate the "missing" count.
  const diarizeApplicable = (d.prepare(`
    SELECT COUNT(*) as cnt
    FROM video_queue vq
    JOIN channels c ON c.id = vq.channel_id
    WHERE vq.status = 'complete' AND COALESCE(c.diarize, 1) = 1
  `).get() as { cnt: number }).cnt;

  // Coverage: AI summaries.
  const summariesCovered = (d.prepare(`
    SELECT COUNT(*) as cnt FROM video_queue
    WHERE status = 'complete' AND ai_summary IS NOT NULL
  `).get() as { cnt: number }).cnt;

  const fts = getTranscriptSearchIndexStats();
  const embeddingsStats = getEmbeddingStats();

  let activeModelCovered = 0;
  if (activeEmbedModel) {
    activeModelCovered = (d.prepare(`
      SELECT COUNT(DISTINCT video_id || ':' || channel_id) as cnt
      FROM vec_segments WHERE model = ?
    `).get(activeEmbedModel) as { cnt: number }).cnt;
  }

  // Speaker rollup.
  const speakerCounts = d.prepare(`
    SELECT
      COUNT(*) as total,
      COALESCE(SUM(CASE WHEN is_noise = 1 THEN 1 ELSE 0 END), 0) as noise
    FROM speakers
  `).get() as { total: number; noise: number };

  const unidentifiedClusters = (d.prepare(`
    SELECT COUNT(*) as cnt FROM video_speaker_assignments
    WHERE speaker_id IS NULL
  `).get() as { cnt: number }).cnt;

  // Per-channel rollups — gather all the per-channel maps once, then zip.
  const channelStatusMap = new Map<string, Record<string, number>>();
  for (const r of d.prepare(`
    SELECT channel_id, status, COUNT(*) as cnt
    FROM video_queue GROUP BY channel_id, status
  `).all() as { channel_id: string; status: string; cnt: number }[]) {
    if (!channelStatusMap.has(r.channel_id)) channelStatusMap.set(r.channel_id, {});
    channelStatusMap.get(r.channel_id)![r.status] = r.cnt;
  }

  const channelDiarizedMap = new Map<string, number>();
  for (const r of d.prepare(`
    SELECT channel_id, COUNT(DISTINCT video_id) as cnt
    FROM video_speaker_assignments GROUP BY channel_id
  `).all() as { channel_id: string; cnt: number }[]) {
    channelDiarizedMap.set(r.channel_id, r.cnt);
  }

  const channelSummarizedMap = new Map<string, number>();
  for (const r of d.prepare(`
    SELECT channel_id, COUNT(*) as cnt
    FROM video_queue
    WHERE status='complete' AND ai_summary IS NOT NULL
    GROUP BY channel_id
  `).all() as { channel_id: string; cnt: number }[]) {
    channelSummarizedMap.set(r.channel_id, r.cnt);
  }

  const channelEmbeddedMap = new Map<string, number>();
  if (activeEmbedModel) {
    for (const r of d.prepare(`
      SELECT channel_id, COUNT(DISTINCT video_id) as cnt
      FROM vec_segments WHERE model = ?
      GROUP BY channel_id
    `).all(activeEmbedModel) as { channel_id: string; cnt: number }[]) {
      channelEmbeddedMap.set(r.channel_id, r.cnt);
    }
  }

  const channelRollups: ChannelRollup[] = channels.map((ch) => {
    const sm = channelStatusMap.get(ch.id) || {};
    const total = Object.values(sm).reduce((s, n) => s + n, 0);
    return {
      id: ch.id,
      name: ch.name,
      enabled: !!ch.enabled,
      diarize: ch.diarize !== false,
      includeShorts: !!ch.include_shorts,
      totalVideos: total,
      completedVideos: sm.complete || 0,
      pendingVideos: sm.pending || 0,
      failedVideos: sm.failed || 0,
      embeddedVideos: channelEmbeddedMap.get(ch.id) || 0,
      summarizedVideos: channelSummarizedMap.get(ch.id) || 0,
      diarizedVideos: channelDiarizedMap.get(ch.id) || 0,
    };
  });

  const failureRows = d.prepare(`
    SELECT video_id, channel_id, title, status, error, updated_at
    FROM video_queue
    WHERE status = 'failed' OR (error IS NOT NULL AND error <> '')
    ORDER BY updated_at DESC LIMIT 10
  `).all() as { video_id: string; channel_id: string; title: string; status: string; error: string | null; updated_at: string }[];

  return {
    archive: {
      channelCount: channels.length,
      enabledChannelCount: channels.filter((c) => c.enabled).length,
      totalVideos,
      completedVideos,
      pendingVideos,
      failedVideos,
      inflightVideos,
      shortsVideos: shortsRow.cnt,
      totalDurationSeconds: totalsRow.duration_total,
      totalWordCount: totalsRow.word_total,
    },
    coverage: {
      transcripts: { covered: transcriptsCovered, total: completedVideos },
      diarization: { covered: diarizedCovered, applicable: diarizeApplicable },
      aiSummaries: { covered: summariesCovered, total: completedVideos },
      fts: { files: fts.files, segments: fts.segments },
      embeddings: {
        activeModel: activeEmbedModel,
        models: embeddingsStats.models,
        activeModelCovered,
        activeModelTotal: completedVideos,
      },
    },
    speakers: {
      total: speakerCounts.total,
      labeled: speakerCounts.total - speakerCounts.noise,
      noise: speakerCounts.noise,
      videosWithDiarization: diarizedCovered,
      unidentifiedClusters,
    },
    channels: channelRollups,
    recentFailures: failureRows.map((r) => ({
      videoId: r.video_id,
      channelId: r.channel_id,
      title: r.title,
      status: r.status,
      error: r.error,
      updatedAt: r.updated_at,
    })),
  };
}
