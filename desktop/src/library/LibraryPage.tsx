import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowLeft, ArrowRight, AudioLines, Library, RefreshCw, X } from "lucide-react";
import { api } from "../lib/ipc.ts";
import { count } from "../lib/format.ts";
import { copyText } from "../lib/clipboard.ts";
import { setLibraryOrder } from "../lib/session.ts";
import { useStoredState } from "../lib/storage.ts";
import { PHONE, TABLET, useMediaQuery } from "../lib/media-query.ts";
import type { LibraryFilter, LibraryPage as Page, LibrarySort, Media, ReviewState } from "../lib/types.ts";
import { Button, IconButton } from "../ui/Button.tsx";
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
import { SetupChecklist } from "../setup/SetupChecklist.tsx";
import { FollowingHeader } from "./FollowingHeader.tsx";
import { LibraryStart } from "./LibraryStart.tsx";
import "./library.css";

let savedScroll = 0;

export function LibraryPage() {
  const { overview, revision, navigate, transcribe, activeJob, jobs, category, setCategory, refresh, route, sources, device, queue } = useApp();
  const collection = route.page === "library" ? route.collection : undefined;
  const source = collection ? sources.find((s) => s.id === collection) : undefined;
  const toast = useToast();
  const phone = useMediaQuery(PHONE);
  const narrow = useMediaQuery(TABLET);
  const [stored, setFilter] = useStoredState<LibraryFilter>("library-filter-v1", DEFAULT_FILTER);
  // A collection shows everything it holds, whichever archive category is in view, and keeps
  // its own page so it doesn't open partway through.
  const [collectionOffset, setCollectionOffset] = useState(0);
  useEffect(() => setCollectionOffset(0), [collection]);
  const filter = collection
    ? { ...normalizeFilter(stored), category: "" as const, channel: "", source: collection, offset: collectionOffset }
    : { ...normalizeFilter(stored), category };
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

  // Several recordings chosen at once, for transcribing again or moving between Personal and Work.
  // The choice survives paging; `allMatching` stands for everything the filter matches.
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [allMatching, setAllMatching] = useState(false);
  const lastPicked = useRef<number | null>(null);
  const clearSelection = useCallback(() => {
    setSelected(new Set());
    setAllMatching(false);
  }, []);
  const selectionKey = JSON.stringify({ ...filter, offset: 0 });
  useEffect(() => {
    clearSelection();
    lastPicked.current = null;
  }, [selectionKey, clearSelection]);
  useEffect(() => {
    if (!selected.size) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && clearSelection();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selected.size]);
  const pick = (index: number, range: boolean) => {
    const list = data?.items ?? [];
    const id = list[index]?.id;
    if (!id) return;
    setAllMatching(false);
    setSelected((old) => {
      const next = new Set(old);
      const on = !old.has(id);
      const from = range && lastPicked.current != null ? Math.min(lastPicked.current, index) : index;
      const to = range && lastPicked.current != null ? Math.max(lastPicked.current, index) : index;
      for (const m of list.slice(from, to + 1)) on ? next.add(m.id) : next.delete(m.id);
      return next;
    });
    lastPicked.current = index;
  };
  const [acting, setActing] = useState(false);
  const transcribeSelected = async () => {
    setActing(true);
    try {
      const ids = allMatching ? await api.libraryIds(filter) : [...selected];
      const result = await api.pipelineEnqueue({ ids, device }, false);
      const extra = [result.alreadyQueued && `${result.alreadyQueued} already queued`, result.unavailable && `${result.unavailable} unavailable`].filter(Boolean).join(" · ");
      const paused = queue && !queue.running;
      toast.success(
        `${count(result.added, "recording")} queued${extra ? ` · ${extra}` : ""}${paused ? " · processing is paused" : ""}`,
        paused ? { label: "Resume", run: () => void api.pipelineAction("start").then(refresh).catch(toast.error) } : undefined,
      );
      clearSelection();
      refresh();
    } catch (e) {
      toast.error(e);
    } finally {
      setActing(false);
    }
  };
  const moveSelected = async (to: "personal" | "work") => {
    setActing(true);
    try {
      await Promise.all([...selected].map((id) => api.setCategory(id, to)));
      toast.success(`${count(selected.size, "recording")} moved to ${to === "work" ? "Work" : "Personal"}`);
      clearSelection();
      refresh();
    } catch (e) {
      toast.error(e);
    } finally {
      setActing(false);
    }
  };

  const update = useCallback(
    (patch: Partial<LibraryFilter>) => {
      if (collection) {
        // Paging and sorting a collection leave the Library's own page alone.
        const { offset, ...rest } = patch;
        setCollectionOffset(offset ?? 0);
        if (Object.keys(rest).length) setFilter((prev) => ({ ...normalizeFilter(prev), ...rest }));
      } else {
        setFilter((prev) => ({ ...normalizeFilter(prev), ...patch, offset: "offset" in patch ? patch.offset! : 0 }));
      }
      window.scrollTo(0, 0);
    },
    [setFilter, collection],
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
    }), ...fileMenu(m, action => setFileAction({media:m,action})), {label:"Extract audio",icon:AudioLines,disabled:!m.path||m.status==="archived",onSelect:()=>{if(m.path)navigate({page:"tools",tab:"extract",source:m.path});}}];

  // A new install opens setup by itself; this stays as a way in if it couldn't.
  if (overview?.media === 0 && !overview.libraryStarted)
    return (
      <Empty
        icon={Library}
        title="Set up your library"
        text="Start a new library or import one. It only takes a moment."
        action={
          <Button variant="primary" onClick={() => navigate({ page: "setup" })}>
            Open setup
          </Button>
        }
      />
    );
  const items = data?.items ?? [];
  const total = data?.total ?? 0;
  const filtered = overview?.media !== 0 && (activeFilterCount(filter) > 0 || !!filter.query.trim() || !!filter.channel || (!collection && !!category));
  const blank = overview?.media === 0;
  const effectiveView = phone ? "list" : view;
  const Item = effectiveView === "grid" ? RecordingCard : RecordingRow;
  const sortBy = (sort: LibrarySort) => update({ sort });
  return (
    <>
      {fileAction && <RecordingFileDialog media={fileAction.media} action={fileAction.action} onClose={()=>setFileAction(undefined)} onSaved={refresh}/>}
      {collection ? (
        source && <FollowingHeader source={source} />
      ) : (
        <>
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
      <SetupChecklist variant="library" />
      {!blank && <SavedViews filter={filter} layout={view} onApply={saved => { lastCategory.current = saved.filter.category; setCategory(saved.filter.category); setFilter({ ...saved.filter, offset: 0 }); setView(saved.layout); window.scrollTo(0, 0); }}/>}
        </>
      )}
      {!blank && <Toolbar
        filter={filter}
        update={update}
        channels={collection ? [] : (data?.channels ?? []).map((c) => c.channel)}
        view={view}
        setView={setView}
        showView={!phone}
        compact={narrow}
      />}
      {effectiveView === "list" && items.length > 0 && (
        <div className="rec-head" role="row">
          <span />
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
      <div
        className={`${effectiveView === "grid" ? "rec-grid" : "rec-list"}${selected.size ? " is-selecting" : ""}`}
        role={effectiveView === "list" ? "table" : undefined}
        aria-multiselectable={effectiveView === "list" ? true : undefined}
      >
        {items.map((m, index) => (
          <Item
            key={m.id}
            media={m}
            transcribing={activeJob?.media_id === m.id}
            menu={menuFor(m)}
            onOpen={() => navigate({ page: "recording", id: m.id })}
            onStar={() => void star(m)}
            selected={selected.has(m.id)}
            onSelect={(range) => pick(index, range)}
          />
        ))}
      </div>
      {selected.size > 0 && (
        <div className="selection-bar" role="toolbar" aria-label="Selected recordings">
          <span className="selection-bar-count">{(allMatching ? total : selected.size).toLocaleString("en-US")} selected</span>
          {!allMatching && items.some((m) => !selected.has(m.id)) ? (
            <Button size="sm" variant="ghost" onClick={() => setSelected((old) => new Set([...old, ...items.map((m) => m.id)]))}>
              Select all {items.length} here
            </Button>
          ) : (
            !allMatching &&
            total > selected.size && (
              <Button size="sm" variant="ghost" onClick={() => setAllMatching(true)}>
                Select all {total.toLocaleString("en-US")} matching
              </Button>
            )
          )}
          <Button size="sm" variant="primary" icon={RefreshCw} disabled={acting} onClick={() => void transcribeSelected()}>
            Transcribe
          </Button>
          {!allMatching && items.some((m) => selected.has(m.id) && m.category !== "work") && (
            <Button size="sm" disabled={acting} onClick={() => void moveSelected("work")}>
              Move to Work
            </Button>
          )}
          {!allMatching && items.some((m) => selected.has(m.id) && m.category === "work") && (
            <Button size="sm" disabled={acting} onClick={() => void moveSelected("personal")}>
              Move to Personal
            </Button>
          )}
          <IconButton size="sm" icon={X} label="Clear selection" onClick={clearSelection} />
        </div>
      )}
      {data && !items.length && (blank && !collection ? (
        <LibraryStart />
      ) : collection && !filtered ? (
        <Empty
          icon={Library}
          title="Nothing here yet"
          text={source?.kind === "folder" ? "Recordings saved in this folder appear here." : "New videos appear here after they're posted."}
        />
      ) : (
        <Empty
          icon={Library}
          title={filtered ? "No recordings match" : "No recordings yet"}
          text={filtered ? "Try a different filter or clear the search." : "Drop recordings anywhere in the window, or use Add."}
        />
      ))}
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
