import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ArrowLeft,
  ChevronRight,
  FileText,
  FolderOpen,
  FolderPlus,
  Pause,
  Pencil,
  Play,
  Plus,
  RefreshCw,
  Search,
  Sparkles,
  Star,
  Trash2,
} from "lucide-react";
import { api } from "../lib/ipc.ts";
import { count } from "../lib/format.ts";
import type { DocumentBody } from "../lib/types.ts";
import { Button, IconButton } from "../ui/Button.tsx";
import { ConfirmDialog, Dialog } from "../ui/Dialog.tsx";
import { Empty } from "../ui/Empty.tsx";
import { PageHeader } from "../ui/PageHeader.tsx";
import { Select } from "../ui/Select.tsx";
import { useToast } from "../ui/Toasts.tsx";
import { useApp } from "../shell/AppContext.tsx";
import type { DocumentInfo, DocumentRoot, DocumentsState } from "./types.ts";
import { documentTree, visibleDocuments, type Folder } from "./tree.ts";
import { Markdown } from "./Markdown.tsx";
import "./documents.css";

export function DocumentsPage({ id }: { id?: string }) {
  const { navigate, revision, refresh, category, setCategory } = useApp();
  const toast = useToast();
  const [data, setData] = useState<DocumentsState>({ roots: [], docs: [] });
  const [loaded, setLoaded] = useState(false),
    [query, setQuery] = useState(""),
    [starred, setStarred] = useState(false);
  const [busy, setBusy] = useState(false),
    [message, setMessage] = useState("");
  const [folder, setFolder] = useState<{
      id?: string;
      path: string;
      label: string;
    }>(),
    [removing, setRemoving] = useState<DocumentRoot>();
  const load = useCallback(async () => {
    setData(await api.documentsState());
    setLoaded(true);
  }, []);
  useEffect(() => {
    let alive = true;
    const update = () =>
      api
        .documentsState()
        .then((d) => {
          if (alive) {
            setData(d);
            setLoaded(true);
          }
        })
        .catch((e) => {
          if (alive) toast.error(e);
        });
    void update();
    const timer = setInterval(() => void update(), 3000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [revision, toast]);
  const sync = async () => {
    setBusy(true);
    try {
      const r = await api.documentsSync();
      setMessage(
        `${r.added} added · ${r.updated} updated · ${r.missing} unavailable${r.errors.length ? ` · ${r.errors.length} could not be read` : ""}`,
      );
      await load();
      refresh();
    } catch (e) {
      toast.error(e);
    } finally {
      setBusy(false);
    }
  };
  const add = async () => {
    try {
      const paths = await api.pickDocuments();
      if (!paths.length) return;
      const n = await api.importDocuments(paths, category || "personal");
      toast.success(`${count(n, "document")} added`);
      await load();
      refresh();
    } catch (e) {
      toast.error(e);
    }
  };
  const saveFolder = async () => {
    if (!folder) return;
    setBusy(true);
    try {
      if (folder.id !== undefined)
        await api.editDocumentRoot(folder.id, { label: folder.label });
      else await api.addDocumentRoot(folder.path, folder.label);
      setFolder(undefined);
      await load();
      await sync();
    } catch (e) {
      toast.error(e);
    } finally {
      setBusy(false);
    }
  };
  const visible = useMemo(
    () => visibleDocuments(data.docs, query, category, starred),
    [data.docs, query, category, starred],
  );
  const selected = data.docs.find((d) => d.id === id);
  const rootIds = new Set(data.roots.map((r) => r.id));
  const groups = [
    ...data.roots.map((r) => ({
      key: r.id,
      label: r.label,
      root: r,
      docs: visible.filter((d) => d.root_id === r.id),
    })),
    {
      key: "__imports__",
      label: "Imported documents",
      root: undefined,
      docs: visible.filter((d) => d.root_id == null || !rootIds.has(d.root_id)),
    },
  ];
  return (
    <div className={`docs-page ${id ? "has-document" : ""}`}>
      <PageHeader
        title="Docs"
        meta={
          loaded
            ? `${count(data.docs.length, "document")} · folders sync every 10 seconds`
            : "Loading…"
        }
        actions={
          <>
            <Button
              size="sm"
              icon={RefreshCw}
              disabled={busy}
              onClick={() => void sync()}
            >
              {busy ? "Syncing…" : "Refresh"}
            </Button>
            <Button size="sm" icon={Plus} onClick={() => void add()}>
              Add files
            </Button>
            <Button
              size="sm"
              variant="primary"
              icon={FolderPlus}
              onClick={() => setFolder({ path: "", label: "" })}
            >
              Add folder
            </Button>
          </>
        }
      />
      <details
        className="document-roots"
        open={!data.roots.length || undefined}
      >
        <summary>
          <FolderOpen size={15} />
          Folders · {data.roots.length}
          <span>
            {data.roots.some((r) => !r.connected || r.error)
              ? "Some folders need attention"
              : "Manage live sources"}
          </span>
        </summary>
        <div className="document-root-list">
          {data.roots.map((r) => (
            <div className="document-root" key={r.id}>
              <div>
                <strong>{r.label}</strong>
                <code>{r.path}</code>
                {(!r.connected || r.error || !r.enabled) && (
                  <small>
                    {!r.enabled
                      ? "Sync paused"
                      : !r.connected
                        ? "Folder unavailable · cached documents are kept"
                        : r.error}
                  </small>
                )}
              </div>
              <IconButton
                icon={r.enabled ? Pause : Play}
                label={`${r.enabled ? "Pause" : "Resume"} ${r.label} sync`}
                onClick={() =>
                  void api
                    .editDocumentRoot(r.id, { enabled: !r.enabled })
                    .then(load)
                    .catch(toast.error)
                }
              />
              <IconButton
                icon={Pencil}
                label={`Rename ${r.label} folder`}
                onClick={() =>
                  setFolder({ id: r.id, path: r.path, label: r.label })
                }
              />
              <IconButton
                icon={Trash2}
                label={`Remove ${r.label} folder`}
                onClick={() => setRemoving(r)}
              />
            </div>
          ))}
          {!data.roots.length && (
            <p>
              Add a folder to keep its Markdown and text files up to date.
              Source files stay in their folders.
            </p>
          )}
        </div>
      </details>
      {message && (
        <p className="docs-sync-message" role="status">
          {message}
        </p>
      )}
      <div className="documents-workspace">
        <aside className="document-browser" aria-label="Document folders">
          <label className="search-field">
            <Search size={15} />
            <input
              type="search"
              aria-label="Filter documents"
              placeholder="Filter files across all folders…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </label>
          <div className="document-filters">
            <Select
              label="Document category"
              value={category}
              onChange={setCategory}
              options={[
                { value: "", label: "Personal + Work" },
                { value: "personal", label: "Personal" },
                { value: "work", label: "Work" },
              ]}
            />
            <IconButton
              icon={Star}
              label={starred ? "Show all documents" : "Show starred documents"}
              className={starred ? "is-starred" : ""}
              onClick={() => setStarred(!starred)}
            />
          </div>
          <div className="document-tree" aria-label="Files">
            {groups
              .filter((g) => g.root || g.docs.length)
              .map((g) => (
                <details key={g.key} open className="document-tree-root">
                  <summary>
                    <FolderOpen size={14} />
                    {g.label}
                    <span>{g.docs.length}</span>
                  </summary>
                  <Tree
                    folder={documentTree(g.docs)}
                    selected={id}
                    expanded={!!query}
                    onOpen={(id) => navigate({ page: "documents", id })}
                  />
                  {!g.docs.length && (
                    <p className="muted">No matching files.</p>
                  )}
                </details>
              ))}
            {loaded && !visible.length && !data.roots.length && (
              <Empty
                icon={FileText}
                title={
                  data.docs.length ? "No matching files" : "Add your sources"
                }
                text={
                  data.docs.length
                    ? "Try another filter."
                    : "Add Markdown or plain text files, or a folder to sync."
                }
              />
            )}
          </div>
          <Button
            size="sm"
            variant="ghost"
            icon={Sparkles}
            title="Uses the embedding provider chosen in Settings"
            disabled={!data.docs.length}
            onClick={() =>
              void api
                .archiveRepair("embed-documents")
                .then(() =>
                  toast.success(
                    "Document indexing started. See Activity for progress.",
                  ),
                )
                .catch(toast.error)
            }
          >
            Update semantic index
          </Button>
        </aside>
        {id ? (
          <DocumentReader
            key={id}
            id={id}
            hash={selected?.content_hash}
            onChanged={() => void load()}
          />
        ) : (
          <div className="document-no-selection">
            <Empty
              icon={FileText}
              title="Choose a document"
              text="Browse a folder or filter by file name. Select a passage while reading to save it as a research note."
            />
          </div>
        )}
      </div>
      <Dialog
        open={!!folder}
        onOpenChange={(open) => !open && !busy && setFolder(undefined)}
        title={
          folder?.id !== undefined
            ? "Rename document folder"
            : "Add document folder"
        }
        footer={
          <>
            <Button
              variant="ghost"
              disabled={busy}
              onClick={() => setFolder(undefined)}
            >
              Cancel
            </Button>
            <Button
              variant="primary"
              disabled={busy || !folder?.path.trim()}
              onClick={() => void saveFolder()}
            >
              Save folder
            </Button>
          </>
        }
      >
        {folder && (
          <div className="document-folder-form">
            {folder.id === undefined && (
              <label className="field">
                Folder path
                <div className="document-folder-path">
                  <input
                    aria-label="Document folder path"
                    value={folder.path}
                    placeholder="/home/you/Documents"
                    onChange={(e) =>
                      setFolder({ ...folder, path: e.target.value })
                    }
                  />
                  <Button
                    onClick={() =>
                      void api
                        .pickFolder("Choose document folder")
                        .then((path) => path && setFolder({ ...folder, path }))
                        .catch(toast.error)
                    }
                  >
                    Browse
                  </Button>
                </div>
              </label>
            )}
            <label className="field">
              Name
              <input
                aria-label="Document folder name"
                value={folder.label}
                placeholder="Uses the folder name when empty"
                onChange={(e) =>
                  setFolder({ ...folder, label: e.target.value })
                }
              />
            </label>
          </div>
        )}
      </Dialog>
      <ConfirmDialog
        open={!!removing}
        onOpenChange={(open) => !open && setRemoving(undefined)}
        title="Remove this folder from live sync?"
        body="Its files stay on disk. Cached documents and research notes remain under Imported documents."
        confirmLabel="Remove folder"
        onConfirm={() => {
          if (removing)
            void api
              .editDocumentRoot(removing.id, { remove: true })
              .then(load)
              .catch(toast.error);
          setRemoving(undefined);
        }}
      />
    </div>
  );
}
function Tree({
  folder,
  selected,
  expanded,
  onOpen,
}: {
  folder: Folder;
  selected?: string;
  expanded: boolean;
  onOpen: (id: string) => void;
}) {
  const contains = (f: Folder): boolean =>
    f.files.some((d) => d.id === selected) || f.folders.some(contains);
  return (
    <ul>
      {folder.folders.map((f) => (
        <li key={f.path}>
          <details open={expanded || contains(f) || undefined}>
            <summary>
              <ChevronRight size={12} />
              <FolderOpen size={13} />
              <span>{f.name}</span>
            </summary>
            <Tree
              folder={f}
              selected={selected}
              expanded={expanded}
              onOpen={onOpen}
            />
          </details>
        </li>
      ))}
      {folder.files.map((d) => (
        <li key={d.id}>
          <button
            className={`document-file ${selected === d.id ? "is-selected" : ""} ${d.missing ? "is-missing" : ""}`}
            title={d.path || d.title}
            onClick={() => onOpen(d.id)}
            aria-current={selected === d.id ? "page" : undefined}
          >
            <FileText size={13} />
            <span>
              {d.relative?.split("/").at(-1) ||
                d.path?.split("/").at(-1) ||
                d.title}
            </span>
            {d.starred === 1 && <Star size={11} />}
          </button>
        </li>
      ))}
    </ul>
  );
}
function DocumentReader({
  id,
  hash,
  onChanged,
}: {
  id: string;
  hash?: string | null;
  onChanged: () => void;
}) {
  const { navigate, setPageTitle, openNote } = useApp();
  const toast = useToast();
  const [doc, setDoc] = useState<DocumentBody>();
  const [passage, setPassage] = useState("");
  const read = useCallback(async () => setDoc(await api.document(id)), [id]);
  useEffect(() => {
    let alive = true;
    api
      .document(id)
      .then((d) => alive && setDoc(d))
      .catch(toast.error);
    return () => {
      alive = false;
    };
  }, [id, hash, toast]);
  useEffect(() => {
    const selection = () => {
      const s = getSelection(),
        paper = document.querySelector(".doc-paper");
      if (
        s &&
        !s.isCollapsed &&
        paper?.contains(s.anchorNode) &&
        paper.contains(s.focusNode)
      )
        setPassage(s.toString().trim());
    };
    document.addEventListener("selectionchange", selection);
    return () => document.removeEventListener("selectionchange", selection);
  }, []);
  useEffect(() => {
    if (doc) setPageTitle(doc.title);
    return () => setPageTitle(null);
  }, [doc?.title, setPageTitle]);
  const edit = async (options: { starred?: boolean; category?: string }) => {
    try {
      await api.editDocument(id, options);
      await read();
      onChanged();
    } catch (e) {
      toast.error(e);
    }
  };
  return (
    <article className="doc-reader">
      <Button
        variant="ghost"
        size="sm"
        icon={ArrowLeft}
        className="doc-back"
        onClick={() => navigate({ page: "documents" })}
      >
        Documents
      </Button>
      {doc ? (
        <>
          <header className="document-reader-head">
            <h1 className="doc-title">{doc.title}</h1>
            <IconButton
              icon={Star}
              label={doc.starred ? "Unstar document" : "Star document"}
              className={doc.starred ? "is-starred" : ""}
              onClick={() => void edit({ starred: !doc.starred })}
            />
          </header>
          <div className="document-reader-tools">
            <Select
              label="Selected document category"
              value={doc.category || "personal"}
              onChange={(category) => void edit({ category })}
              size="sm"
              options={[
                { value: "personal", label: "Personal" },
                { value: "work", label: "Work" },
              ]}
            />
            {doc.path && (
              <Button
                size="sm"
                variant="ghost"
                icon={FolderOpen}
                onClick={() => void api.reveal(doc.path!).catch(toast.error)}
              >
                Show in folder
              </Button>
            )}
            {doc.author &&
              (doc.speaker_id ? (
                <button
                  className="document-author"
                  style={{ color: doc.speaker_color || undefined }}
                  onClick={() =>
                    navigate({ page: "speakers", id: doc.speaker_id! })
                  }
                >
                  By {doc.speaker_name}
                </button>
              ) : (
                <span className="muted">By {doc.author}</span>
              ))}
          </div>
          {doc.error && (
            <p className="document-warning" role="status">
              {doc.error}
            </p>
          )}
          {passage && (
            <div className="document-selection">
              <Button
                variant="primary"
                size="sm"
                onClick={() =>
                  openNote({
                    title: `${doc.title} · passage`,
                    body: "",
                    anchors: [
                      { doc_id: doc.id, title: doc.title, quote: passage },
                    ],
                  })
                }
              >
                Save passage as note
              </Button>
              <span className="muted">{passage.length} characters</span>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  setPassage("");
                  getSelection()?.removeAllRanges();
                }}
              >
                Clear
              </Button>
            </div>
          )}
          <div className="doc-paper">
            {doc.body.trim() ? (
              <Markdown
                source={doc.body}
                omitTitle={doc.title}
                documentId={doc.id}
                onDocument={(id) => navigate({ page: "documents", id })}
              />
            ) : (
              <Empty
                icon={FileText}
                title="No text was indexed"
                text="This source has no readable text yet."
              />
            )}
          </div>
          {!!doc.notes?.length && (
            <section className="document-research">
              <h2>Research notes</h2>
              {doc.notes.map((n) => (
                <Button
                  key={n.id}
                  variant="ghost"
                  onClick={() =>
                    void api
                      .research()
                      .then((r) => {
                        const note = r.notes.find((x) => x.id === n.id);
                        if (note) openNote(note);
                      })
                      .catch(toast.error)
                  }
                >
                  {n.title}
                </Button>
              ))}
            </section>
          )}
        </>
      ) : (
        <p className="muted">Loading document…</p>
      )}
    </article>
  );
}
