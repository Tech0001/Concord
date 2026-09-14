import { useEffect, useMemo, useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { useLocation } from "wouter";
import { Activity, Clock3, FileText, HeartPulse, Loader2, MessageSquareText, NotebookPen, Plus, Search, SplitSquareHorizontal, User, Video, X } from "lucide-react";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from "@/components/ui/command";
import { cn } from "@/lib/utils";

interface CommandResult {
  id: string;
  type: "video" | "doc" | "note" | "speaker" | "chat";
  title: string;
  subtitle: string;
  href: string;
}

const iconByType = {
  video: Video,
  doc: FileText,
  note: NotebookPen,
  speaker: User,
  chat: MessageSquareText,
};

export function GlobalCommandPalette() {
  const [, navigate] = useLocation();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<CommandResult[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setOpen(value => !value);
      }
    };
    const onOpen = () => setOpen(true);
    document.addEventListener("keydown", onKey);
    window.addEventListener("concord:open-command", onOpen);
    return () => {
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("concord:open-command", onOpen);
    };
  }, []);

  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    const timer = window.setTimeout(async () => {
      setLoading(true);
      try {
        const response = await fetch(`/api/command/search?q=${encodeURIComponent(query)}&limit=6`, { signal: controller.signal, cache: "no-store" });
        if (!response.ok) return;
        const data = await response.json() as { results?: CommandResult[] };
        setResults(data.results || []);
      } catch { /* aborted searches are expected while typing */ }
      finally { if (!controller.signal.aborted) setLoading(false); }
    }, query ? 140 : 0);
    return () => { window.clearTimeout(timer); controller.abort(); };
  }, [open, query]);

  useEffect(() => {
    if (!open) setQuery("");
  }, [open]);

  const grouped = useMemo(() => {
    const groups = new Map<string, CommandResult[]>();
    for (const result of results) groups.set(result.type, [...(groups.get(result.type) || []), result]);
    return Array.from(groups.entries());
  }, [results]);

  const go = (href: string) => {
    setOpen(false);
    navigate(href);
  };

  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-[80] bg-black/50 backdrop-blur-[1px] data-[state=open]:animate-in data-[state=closed]:animate-out" />
        <Dialog.Content
          aria-describedby={undefined}
          className="fixed left-1/2 top-[12vh] z-[81] w-[calc(100vw-2rem)] max-w-2xl -translate-x-1/2 overflow-hidden rounded-xl border bg-popover shadow-2xl outline-none"
        >
          <Dialog.Title className="sr-only">Search Concord or run a command</Dialog.Title>
          <Command shouldFilter={false}>
            <div className="relative">
              <CommandInput autoFocus value={query} onValueChange={setQuery} placeholder="Find videos, documents, notes, speakers, chats—or run a command…" className="h-12 pr-16" />
              <div className="pointer-events-none absolute right-3 top-1/2 flex -translate-y-1/2 items-center gap-1 text-[10px] text-muted-foreground">
                {loading && <Loader2 className="mr-1 h-3 w-3 animate-spin" />}
                <kbd className="rounded border bg-muted px-1.5 py-0.5">Esc</kbd>
              </div>
            </div>
            <CommandList className="max-h-[60vh]">
              <CommandEmpty>{loading ? "Searching…" : "No matching source or command."}</CommandEmpty>
              <CommandGroup heading="Actions">
                <CommandItem value="create-new-research-note" onSelect={() => go("/notes?new=1")}>
                  <Plus className="h-4 w-4" /><span className="flex-1">Create research note</span><span className="text-[10px] text-muted-foreground">Notes</span>
                </CommandItem>
                <CommandItem value="show-failed-jobs" onSelect={() => go("/status#background-jobs")}>
                  <Activity className="h-4 w-4" /><span className="flex-1">Show failed background jobs</span><span className="text-[10px] text-muted-foreground">Status</span>
                </CommandItem>
                <CommandItem value="archive-health-repair" onSelect={() => go("/health")}>
                  <HeartPulse className="h-4 w-4" /><span className="flex-1">Run Archive Health & Repair</span><span className="text-[10px] text-muted-foreground">Health</span>
                </CommandItem>
                <CommandItem value="compare-sources" onSelect={() => go("/compare")}>
                  <SplitSquareHorizontal className="h-4 w-4" /><span className="flex-1">Compare two sources</span><span className="text-[10px] text-muted-foreground">Research</span>
                </CommandItem>
                <CommandItem value="open-recent-library" onSelect={() => go("/library?sort=recently_viewed")}>
                  <Clock3 className="h-4 w-4" /><span className="flex-1">Open recently viewed media</span><span className="text-[10px] text-muted-foreground">Library</span>
                </CommandItem>
              </CommandGroup>
              {grouped.length > 0 && <CommandSeparator />}
              {grouped.map(([type, items]) => (
                <CommandGroup key={type} heading={`${type[0].toUpperCase()}${type.slice(1)}${type === "doc" ? "uments" : "s"}`}>
                  {items.map(result => {
                    const Icon = iconByType[result.type] || Search;
                    return (
                      <CommandItem key={result.id} value={result.id} onSelect={() => go(result.href)}>
                        <Icon className={cn("h-4 w-4 shrink-0", result.type === "video" && "text-violet-500", result.type === "doc" && "text-blue-500", result.type === "note" && "text-amber-500")} />
                        <div className="min-w-0 flex-1">
                          <div className="truncate">{result.title}</div>
                          <div className="truncate text-[10px] text-muted-foreground">{result.subtitle}</div>
                        </div>
                      </CommandItem>
                    );
                  })}
                </CommandGroup>
              ))}
            </CommandList>
          </Command>
          <Dialog.Close className="sr-only"><X />Close</Dialog.Close>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

declare global {
  interface WindowEventMap { "concord:open-command": Event }
}
