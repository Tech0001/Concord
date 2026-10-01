import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowLeft, ArrowRight, Library } from "lucide-react";
import { api } from "../lib/ipc.ts";
import { count } from "../lib/format.ts";
import { copyText } from "../lib/clipboard.ts";
import { setLibraryOrder } from "../lib/session.ts";
import { useStoredState } from "../lib/storage.ts";
import { PHONE, TABLET, useMediaQuery } from "../lib/media-query.ts";
import type { LibraryFilter, LibraryPage as Page, LibrarySort, Media, ReviewState } from "../lib/types.ts";
import { Button } from "../ui/Button.tsx";
import { Empty } from "../ui/Empty.tsx";
import { PageHeader } from "../ui/PageHeader.tsx";
import { Select } from "../ui/Select.tsx";
import { useToast } from "../ui/Toasts.tsx";
import { useApp } from "../shell/AppContext.tsx";
import { DEFAULT_FILTER, normalizeFilter } from "./model.ts";
import { RecordingFileDialog, fileMenu, type FileAction } from "./RecordingFileDialog.tsx";
import { SavedViews } from "./SavedViews.tsx";
import { recordingMenu } from "./recordingMenu.ts";
import { RecordingCard } from "./RecordingCard.tsx";
import { RecordingRow } from "./RecordingRow.tsx";
import { activeFilterCount, Toolbar } from "./Toolbar.tsx";
import { Welcome } from "./Welcome.tsx";
import "./library.css";

let savedScroll = 0;

export function LibraryPage() {
  const { overview, revision, navigate, transcribe, activeJob, jobs, category, setCategory, refresh } = useApp();
  const toast = useToast();
  const phone = useMediaQuery(PHONE);
  const narrow = useMediaQuery(TABLET);
  const [stored, setFilter] = useStoredState<LibraryFilter>("library-filter-v1", DEFAULT_FILTER);
  const filter = { ...normalizeFilter(stored), category };
  const lastCategory = useRef(category);
  useEffect(() => {
    if (lastCategory.current !== category) {
      lastCategory.current = category;
      setFilter(prev => ({ ...normalizeFilter(prev), category, channel: "", offset: 0 }));
    }
  }, [category, setFilter]);
  const [view, setView] = useStoredState<"grid" | "list">("library-view-v1", "grid", (v) => v === "grid" || v === "list");
  const [data, setData] = useState<Page>();
  const [fileAction, setFileAction] = useState<{media:Media;action:FileAction}>();
  const [loading, setLoading] = useState(true);
  const restored = useRef(false);

  const key = JSON.stringify(filter);
  useEffect(() => {
    let alive = true;
    setLoading(true);
    const timer = setTimeout(() => {
      api
        .library(filter)
        .then((page) => {
          if (!alive) return;
          setData(page);
          setLibraryOrder(page.items);
          if (!restored.current) {
            restored.current = true;
            requestAnimationFrame(() => window.scrollTo(0, savedScroll));
          }
        })
        .catch((e) => alive && toast.error(e))
        .finally(() => alive && setLoading(false));
    }, 150);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
    // The filter is compared by value through `key`.
  }, [key, revision, toast]);
  useEffect(() => () => void (savedScroll = window.scrollY), []);

  const update = useCallback(
    (patch: Partial<LibraryFilter>) => {
      setFilter((prev) => ({ ...normalizeFilter(prev), ...patch, offset: "offset" in patch ? patch.offset! : 0 }));
      window.scrollTo(0, 0);
    },
    [setFilter],
  );
  const patchItem = (id: string, patch: Partial<Media>) =>
    setData((d) => d && { ...d, items: d.items.map((m) => (m.id === id ? { ...m, ...patch } : m)) });
  const star = async (m: Media) => {
    patchItem(m.id, { starred: m.starred ? 0 : 1 });
    try {
      await api.setStarred(m.id, !m.starred);
    } catch (e) {
      patchItem(m.id, { starred: m.starred });
      toast.error(e);
    }
  };
  const review = async (m: Media, state: ReviewState) => {
    patchItem(m.id, { review_state: state });
    try {
      await api.setReview(m.id, state);
    } catch (e) {
      patchItem(m.id, { review_state: m.review_state });
      toast.error(e);
    }
  };
  const menuFor = (m: Media) => () =>
    [...recordingMenu(m, {
      open: (at) => navigate({ page: "recording", id: m.id, ...(at != null ? { at } : {}) }),
      transcribe: () => void transcribe(m.id),
      setStarred: () => void star(m),
      setCategory: c => { void api.setCategory(m.id, c).then(refresh).catch(toast.error); },
      setReview: (s) => void review(m, s),
      reveal: () => m.path && api.reveal(m.path).catch(toast.error),
      copyPath: () =>
        m.path &&
        copyText(m.path)
          .then(() => toast.success("File path copied"))
          .catch(toast.error),
      transcribeDisabled: jobs.some(j => j.media_id === m.id && ["running", "queued", "retry"].includes(j.status)),
    }), ...fileMenu(m, action => setFileAction({media:m,action}))];

  if (overview?.media === 0) return <Welcome />;
  const items = data?.items ?? [];
  const total = data?.total ?? 0;
  const filtered = activeFilterCount(filter) > 0 || !!filter.query.trim() || !!filter.channel || !!category;
  const effectiveView = phone ? "list" : view;
  const Item = effectiveView === "grid" ? RecordingCard : RecordingRow;
  const sortBy = (sort: LibrarySort) => update({ sort });
  return (
    <>
      {fileAction && <RecordingFileDialog media={fileAction.media} action={fileAction.action} onClose={()=>setFileAction(undefined)} onSaved={refresh}/>}
      <PageHeader
        title="Library"
        meta={
          data ? (
            <>
              {count(total, "recording")} · {data.transcribed.toLocaleString("en-US")} transcribed
              {filtered && <span className="muted"> · filtered</span>}
              {loading && <span className="muted"> · updating…</span>}
            </>
          ) : (
            "Loading…"
          )
        }
      />
      <SavedViews filter={filter} layout={view} onApply={saved => { lastCategory.current = saved.filter.category; setCategory(saved.filter.category); setFilter({ ...saved.filter, offset: 0 }); setView(saved.layout); window.scrollTo(0, 0); }}/>
      <Toolbar
        filter={filter}
        update={update}
        channels={(data?.channels ?? []).map((c) => c.channel)}
        view={view}
        setView={setView}
        showView={!phone}
        compact={narrow}
      />
      {effectiveView === "list" && items.length > 0 && (
        <div className="rec-head" role="row">
          <span />
          <span className="rec-row-thumb" />
          <button type="button" className="rec-head-sort" onClick={() => sortBy(filter.sort === "newest" ? "oldest" : "newest")}>
            Date
          </button>
          <button type="button" className="rec-head-sort" onClick={() => sortBy("title")}>
            Title
          </button>
          <span className="rec-row-channel">Collection</span>
          <button type="button" className="rec-head-sort rec-row-num" onClick={() => sortBy("longest")}>
            Length
          </button>
          <button type="button" className="rec-head-sort rec-row-num rec-row-words" onClick={() => sortBy("words")}>
            Words
          </button>
          <span className="rec-row-status">Status</span>
          <span />
        </div>
      )}
      <div className={effectiveView === "grid" ? "rec-grid" : "rec-list"} role={effectiveView === "list" ? "table" : undefined}>
        {items.map((m) => (
          <Item
            key={m.id}
            media={m}
            transcribing={activeJob?.media_id === m.id}
            menu={menuFor(m)}
            onOpen={() => navigate({ page: "recording", id: m.id })}
            onStar={() => void star(m)}
          />
        ))}
      </div>
      {data && !items.length && (
        <Empty
          icon={Library}
          title={filtered ? "No recordings match" : "No recordings yet"}
          text={filtered ? "Try a different filter or clear the search." : "Add recordings to start your archive."}
        />
      )}
      {total > 0 && (
        <footer className="pagination">
          <Button size="sm" icon={ArrowLeft} disabled={!filter.offset} onClick={() => update({ offset: Math.max(0, filter.offset - filter.limit) })}>
            Previous
          </Button>
          <span className="num muted">
            {(filter.offset + 1).toLocaleString("en-US")}–{Math.min(filter.offset + filter.limit, total).toLocaleString("en-US")} of{" "}
            {total.toLocaleString("en-US")}
          </span>
          <Button size="sm" disabled={filter.offset + filter.limit >= total} onClick={() => update({ offset: filter.offset + filter.limit })}>
            Next <ArrowRight size={14} aria-hidden />
          </Button>
          <span className="pagination-size">
            <span className="muted">Show</span>
            <Select
              size="sm"
              label="Recordings per page"
              value={String(filter.limit) as "60" | "120" | "240"}
              onChange={(v) => update({ limit: Number(v) as LibraryFilter["limit"] })}
              options={[
                { value: "60", label: "60" },
                { value: "120", label: "120" },
                { value: "240", label: "240" },
              ]}
            />
          </span>
        </footer>
      )}
    </>
  );
}
