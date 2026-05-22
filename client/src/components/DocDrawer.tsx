import { useEffect, useState } from "react";
import { Link } from "wouter";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { ExternalLink, FileText, Loader2 } from "lucide-react";
import { Markdown } from "@/components/Markdown";
import { apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";

export interface DocDrawerEntry {
  /** Indexed document id — used to build the deep link to the full
   *  Docs page. Optional; we can still open the file with just
   *  rootId + relPath. */
  documentId?: string;
  rootId?: string;
  relPath: string;
  title: string;
  /** Cited passage. When present, the viewer scrolls to + highlights
   *  the first matching span after the markdown renders. Pulled from
   *  the same payload as the chat citation / note anchor. */
  excerpt?: string | null;
  /** Optional sub-label for the title bar — currently used to show
   *  the heading path for chunk citations ("Section › Subsection"). */
  subtitle?: string | null;
}

/**
 * Markdown counterpart to VideoDrawer. Pops out from the right edge,
 * loads the file via /api/docs/file, renders the markdown, and scrolls
 * to the cited passage on mount. Keeps the calling context (AI chat,
 * Notes, Search, Map) visible so the user doesn't lose their place.
 *
 * "Open in Docs page" provides a fallback for users who want the full
 * tree + filter UI; that link carries the same path/rootId/excerpt
 * params so the standalone page lands in the same spot.
 */
export function DocDrawer({
  open,
  onOpenChange,
  doc,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  doc: DocDrawerEntry | null;
}) {
  const { toast } = useToast();
  const [content, setContent] = useState<string>("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open || !doc) {
      setContent("");
      setError(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    (async () => {
      try {
        const qs = new URLSearchParams({ path: doc.relPath });
        if (doc.rootId) qs.set("rootId", doc.rootId);
        const r = await apiRequest("GET", `/api/docs/file?${qs.toString()}`);
        if (!r.ok) {
          const data = await r.json().catch(() => ({}));
          throw new Error(data.error || `HTTP ${r.status}`);
        }
        const text = await r.text();
        if (!cancelled) setContent(text);
      } catch (err: any) {
        if (!cancelled) {
          setError(err.message);
          toast({ variant: "destructive", title: "Failed to open doc", description: err.message });
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [open, doc?.relPath, doc?.rootId, toast]);

  // Post-render scroll + highlight for the cited passage. Same
  // approach as the standalone /docs page: walk text nodes inside
  // .markdown-body, find the first one whose content contains the
  // excerpt's first ~60 chars, scroll into view, and add a temporary
  // highlight class. We can't reliably map source char offsets to DOM
  // positions because markdown syntax shifts source positions away
  // from rendered text positions.
  useEffect(() => {
    if (!open || !content || !doc?.excerpt) return;
    const needle = doc.excerpt.slice(0, Math.min(60, doc.excerpt.length)).trim();
    if (!needle) return;
    const id = requestAnimationFrame(() => {
      const root = document.querySelector("[data-doc-drawer] .markdown-body");
      if (!root) return;
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      let node: Node | null;
      while ((node = walker.nextNode())) {
        const text = node.nodeValue ?? "";
        if (text.indexOf(needle) >= 0) {
          const parent = node.parentElement;
          if (parent) {
            parent.scrollIntoView({ behavior: "smooth", block: "center" });
            parent.classList.add("docs-cite-highlight");
            setTimeout(() => parent.classList.remove("docs-cite-highlight"), 4000);
          }
          break;
        }
      }
    });
    return () => cancelAnimationFrame(id);
  }, [open, content, doc?.excerpt]);

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        data-doc-drawer
        className="w-full overflow-y-auto p-0 sm:max-w-2xl lg:max-w-3xl"
      >
        {doc ? (
          <>
            <SheetHeader className="border-b pr-12 px-4 py-3">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0 flex-1">
                  <SheetTitle className="flex items-center gap-2 text-base">
                    <FileText className="h-4 w-4 shrink-0 text-blue-500" />
                    <span className="line-clamp-2">{doc.title}</span>
                  </SheetTitle>
                  {/* Visually displayed as the sub-line; also satisfies
                      Radix's a11y check (Dialog wants a Description
                      paired with the Title or aria-describedby). */}
                  <SheetDescription asChild>
                    <p className="mt-0.5 truncate font-mono text-[11px] text-muted-foreground" title={doc.relPath}>
                      {doc.subtitle ? `${doc.subtitle} · ` : ""}{doc.relPath}
                    </p>
                  </SheetDescription>
                </div>
                <Link
                  href={`/docs?${buildOpenInDocsQs(doc)}`}
                  onClick={() => onOpenChange(false)}
                  className="shrink-0"
                >
                  <Button size="sm" variant="ghost" className="h-7 text-xs" title="Open in the full Docs page">
                    <ExternalLink className="h-3.5 w-3.5" />
                    Open
                  </Button>
                </Link>
              </div>
            </SheetHeader>
            <div className="px-6 py-4">
              {loading ? (
                <div className="flex items-center gap-2 text-sm text-muted-foreground">
                  <Loader2 className="h-4 w-4 animate-spin" /> Loading…
                </div>
              ) : error ? (
                <div className="text-sm text-destructive">{error}</div>
              ) : (
                <Markdown source={content} />
              )}
            </div>
          </>
        ) : null}
      </SheetContent>
    </Sheet>
  );
}

function buildOpenInDocsQs(doc: DocDrawerEntry): string {
  const qs = new URLSearchParams({ path: doc.relPath });
  if (doc.rootId) qs.set("rootId", doc.rootId);
  if (doc.excerpt) qs.set("excerpt", doc.excerpt);
  return qs.toString();
}
