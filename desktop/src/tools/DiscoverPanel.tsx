import { useEffect, useMemo, useRef, useState } from "react";
import {
  Compass,
  Download,
  ExternalLink,
  Search,
  Settings2,
} from "lucide-react";
import { api } from "../lib/ipc.ts";
import { useApp } from "../shell/AppContext.tsx";
import { Button } from "../ui/Button.tsx";
import { Select } from "../ui/Select.tsx";
import { Empty } from "../ui/Empty.tsx";
import { Chip } from "../ui/Chip.tsx";
import { useToast } from "../ui/Toasts.tsx";
import {
  appendHits,
  phrases,
  relevance,
  type YouTubeHit,
  type YouTubeQuery,
} from "./discover-model.ts";

const orders = [
  { value: "relevance", label: "Most relevant" },
  { value: "date", label: "Newest first" },
  { value: "viewCount", label: "Most viewed" },
  { value: "rating", label: "Top rated" },
  { value: "title", label: "Title A–Z" },
];
export function DiscoverPanel() {
  const { navigate, category, refresh } = useApp();
  const toast = useToast();
  const [configured, setConfigured] = useState<boolean>();
  const [query, setQuery] = useState("");
  const [order, setOrder] = useState("relevance");
  const [scope, setScope] = useState<string>(category || "personal");
  const [include, setInclude] = useState("");
  const [exclude, setExclude] = useState("");
  const [onlyMatches, setOnlyMatches] = useState(false);
  const [hits, setHits] = useState<YouTubeHit[]>([]);
  const [next, setNext] = useState<string | null>(null);
  const [last, setLast] = useState<YouTubeQuery>();
  const [busy, setBusy] = useState(false);
  const [queuing, setQueuing] = useState<string>();
  const [error, setError] = useState("");
  const generation = useRef(0);
  useEffect(() => {
    let alive = true;
    void api
      .youtubeStatus()
      .then((s) => {
        if (alive) setConfigured(s.hasKey);
      })
      .catch((e) => {
        if (alive) setError(String(e));
      });
    return () => {
      alive = false;
      generation.current++;
    };
  }, []);
  const search = async (more = false) => {
    const request =
      more && last
        ? { ...last, pageToken: next ?? undefined }
        : { query: query.trim(), order };
    if (!request.query) return;
    const current = ++generation.current;
    setBusy(true);
    setError("");
    try {
      const page = await api.youtubeSearch(request);
      if (current !== generation.current) return;
      setHits((old) => (more ? appendHits(old, page.hits) : page.hits));
      setNext(page.nextPageToken);
      setLast({ ...request, pageToken: undefined });
    } catch (e) {
      if (current === generation.current)
        setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (current === generation.current) setBusy(false);
    }
  };
  const queue = async (hit: YouTubeHit) => {
    setQueuing(hit.videoId);
    try {
      const result = await api.youtubeQueue(hit, scope);
      setHits((old) =>
        old.map((h) =>
          h.videoId === hit.videoId ? { ...h, mediaId: result.id } : h,
        ),
      );
      refresh();
      toast.success(
        result.action === "existing"
          ? "This recording is already in your archive"
          : result.action === "alreadyQueued"
            ? "This recording is already queued"
            : "Added to the download and transcription queue",
        { label: "Open Pipeline", run: () => navigate({ page: "pipeline" }) },
      );
    } catch (e) {
      toast.error(e);
    } finally {
      setQueuing(undefined);
    }
  };
  const tagged = useMemo(() => {
    const inc = phrases(include),
      exc = phrases(exclude);
    return hits.map((hit) => ({ hit, tint: relevance(hit, inc, exc) }));
  }, [hits, include, exclude]);
  const matches = tagged.filter(
    (item) =>
      item.tint !== "exclude" && (!include.trim() || item.tint === "include"),
  );
  const shown = onlyMatches ? matches : tagged;
  return (
    <div className="discover-panel">
      <section className="tool-panel">
        <div className="tool-heading">
          <Compass size={22} />
          <div>
            <h2>Discover on YouTube</h2>
            <p>
              Search online, review recordings, and send your choices to
              Pipeline.
            </p>
          </div>
        </div>
        {configured === false ? (
          <Empty
            icon={Settings2}
            title="Set up YouTube search"
            text="Add a YouTube Data API v3 key in Settings. Your local archive search is always available without it."
            action={
              <Button onClick={() => navigate({ page: "settings" })}>
                Open Settings
              </Button>
            }
          />
        ) : (
          <>
            <form
              className="discover-search"
              onSubmit={(e) => {
                e.preventDefault();
                void search();
              }}
            >
              <input
                aria-label="Search YouTube"
                placeholder="Search YouTube…"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                disabled={busy || configured == null}
              />
              <Select
                label="YouTube search order"
                value={order}
                onChange={setOrder}
                disabled={busy || configured == null}
                options={orders}
              />
              <Button
                type="submit"
                icon={Search}
                variant="primary"
                disabled={busy || !query.trim() || !configured}
              >
                {busy ? "Searching…" : "Search"}
              </Button>
            </form>
            <div className="tool-two-fields">
              <label className="field">
                Highlight phrases
                <input
                  aria-label="Discover include phrases"
                  value={include}
                  placeholder="Any of these phrases, separated by commas"
                  onChange={(e) => setInclude(e.target.value)}
                />
              </label>
              <label className="field">
                Exclude phrases
                <input
                  aria-label="Discover exclude phrases"
                  value={exclude}
                  placeholder="Phrases to mark as excluded"
                  onChange={(e) => setExclude(e.target.value)}
                />
              </label>
            </div>
            <div className="discover-options">
              <label className="checkbox-field">
                <input
                  type="checkbox"
                  checked={onlyMatches}
                  onChange={(e) => setOnlyMatches(e.target.checked)}
                />
                Show matching results only
              </label>
              <Select
                label="Category for discovered recordings"
                value={scope}
                onChange={setScope}
                options={[
                  { value: "personal", label: "Add to Personal" },
                  { value: "work", label: "Add to Work" },
                ]}
              />
            </div>
            <small className="muted">
              Queries go to Google. Each Search or Load more requests one page.
              Phrase filters run on the results already loaded. Queue downloads
              respects Pipeline’s paused or running state.
            </small>
          </>
        )}
        {error && (
          <p role="alert" className="field-error">
            {error}
          </p>
        )}
      </section>
      {last && (
        <>
          <p className="muted" role="status">
            {hits.length} results loaded for “{last.query}” · {matches.length}{" "}
            match your phrase filters
          </p>
          <section
            className="discover-results"
            aria-label="YouTube search results"
          >
            {shown.map(({ hit, tint }) => (
              <article
                className="discover-hit"
                key={hit.videoId}
                data-match={tint}
              >
                <img
                  src={`https://i.ytimg.com/vi/${hit.videoId}/mqdefault.jpg`}
                  alt=""
                  loading="lazy"
                  referrerPolicy="no-referrer"
                />
                <div className="discover-hit-content">
                  <h3>{hit.title}</h3>
                  <small>
                    {hit.channelName}
                    {hit.publishedAt && ` · ${hit.publishedAt.slice(0, 10)}`}
                  </small>
                  <p>{hit.description}</p>
                  <div className="tool-actions">
                    {hit.live && <Chip tone="accent">Live or upcoming</Chip>}
                    {tint !== "neutral" && (
                      <Chip tone={tint === "include" ? "success" : "neutral"}>
                        {tint === "include"
                          ? "Phrase match"
                          : "Excluded phrase"}
                      </Chip>
                    )}
                    {hit.mediaId ? (
                      <Button
                        size="sm"
                        onClick={() =>
                          navigate({ page: "recording", id: hit.mediaId! })
                        }
                      >
                        In library
                      </Button>
                    ) : (
                      <Button
                        size="sm"
                        icon={Download}
                        disabled={!!queuing}
                        onClick={() => void queue(hit)}
                      >
                        {queuing === hit.videoId
                          ? "Queueing…"
                          : "Queue download"}
                      </Button>
                    )}
                    <Button
                      size="sm"
                      variant="ghost"
                      icon={ExternalLink}
                      onClick={() =>
                        void api
                          .openExternal(
                            `https://www.youtube.com/watch?v=${hit.videoId}`,
                          )
                          .catch(toast.error)
                      }
                    >
                      YouTube
                    </Button>
                  </div>
                </div>
              </article>
            ))}
            {!shown.length && (
              <Empty
                icon={Search}
                title={
                  hits.length
                    ? "No results match these phrases"
                    : "No recordings found"
                }
                text={
                  hits.length
                    ? "Adjust the phrase filters or load another page."
                    : "Try another search or load more if YouTube has another page."
                }
              />
            )}
          </section>
          {next && (
            <Button
              className="discover-more"
              disabled={busy}
              onClick={() => void search(true)}
            >
              {busy ? "Loading…" : "Load more"}
            </Button>
          )}
        </>
      )}
    </div>
  );
}
