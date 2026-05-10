import { useEffect, useMemo, useRef, useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import { Loader2, Plus, Sparkles, Tag, X } from "lucide-react";

interface TagOption {
  tag: string;
  count: number;
}

interface TagPickerProps {
  value: string[];
  onChange: (tags: string[]) => void;
  options?: TagOption[];
  placeholder?: string;
  className?: string;
  size?: "sm" | "default";
  /** Called once when the picker opens. Use to refresh tag options lazily. */
  onOpen?: () => void;
  /** When set, the picker fetches AI-suggested tags from the chat model
   *  on open and shows them in a "Suggested" group above existing tags.
   *  No fetch / no group when omitted. */
  quote?: string;
}

function normalize(tag: string): string {
  return tag.trim().toLowerCase().replace(/\s+/g, " ");
}

/**
 * Multi-select tag input.
 *  - Click the trigger to open a Combobox over existing tags.
 *  - Type to filter or to add a brand-new tag (Enter or "Add" item).
 *  - Hierarchical tags use dot-notation (e.g. "religion.end-times.rapture");
 *    typing "religion." narrows the list to that subtree.
 */
export function TagPicker({
  value,
  onChange,
  options = [],
  placeholder = "Add tags...",
  className,
  size = "default",
  onOpen,
  quote,
}: TagPickerProps) {
  const [open, setOpen] = useState(false);
  const [input, setInput] = useState("");
  const [suggestedTags, setSuggestedTags] = useState<string[]>([]);
  const [suggestLoading, setSuggestLoading] = useState(false);
  const [suggestError, setSuggestError] = useState<string | null>(null);
  // Cache the last quote we fetched for so opening/closing doesn't re-hit
  // the LLM unless the clip text actually changes.
  const lastFetchedQuoteRef = useRef<string | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const onOpenRef = useRef(onOpen);
  onOpenRef.current = onOpen;

  useEffect(() => {
    if (open) onOpenRef.current?.();
  }, [open]);

  // Fetch AI suggestions when the picker opens (and quote is non-empty,
  // and we haven't already fetched for this exact quote). Best-effort:
  // any error is swallowed to a small inline note, never blocks the UI.
  useEffect(() => {
    if (!open || !quote || quote.trim().length === 0) return;
    const trimmed = quote.trim();
    if (lastFetchedQuoteRef.current === trimmed) return;
    lastFetchedQuoteRef.current = trimmed;
    let cancelled = false;
    setSuggestLoading(true);
    setSuggestError(null);
    setSuggestedTags([]);
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 30_000);
    fetch("/api/clips/suggest-tags", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ quote: trimmed }),
      signal: ctl.signal,
    })
      .then(async (r) => {
        if (cancelled) return;
        if (!r.ok) {
          const data = await r.json().catch(() => ({}));
          if (data.error === "no_chat_model") {
            setSuggestError("Configure a chat model on the AI page to get suggestions.");
          } else {
            setSuggestError(data.message || data.error || `HTTP ${r.status}`);
          }
          return;
        }
        const data = await r.json();
        setSuggestedTags(Array.isArray(data.suggestions) ? data.suggestions : []);
      })
      .catch((err) => {
        if (cancelled) return;
        setSuggestError(err.name === "AbortError" ? "Suggestion request timed out" : String(err));
      })
      .finally(() => {
        if (!cancelled) setSuggestLoading(false);
        clearTimeout(timer);
      });
    return () => { cancelled = true; ctl.abort(); clearTimeout(timer); };
  }, [open, quote]);

  const selected = useMemo(() => new Set(value.map(normalize)), [value]);
  const inputN = normalize(input);

  const suggestions = useMemo(() => {
    return options
      .filter(option => !selected.has(option.tag))
      .filter(option => !inputN || option.tag.includes(inputN));
  }, [options, selected, inputN]);

  // AI suggestions, filtered against already-selected and against current
  // input. Tags that are already in the existing options list still appear
  // here (with a slightly different visual cue) since the model
  // explicitly recommended them — that's signal worth preserving.
  const aiSuggestions = useMemo(() => {
    return suggestedTags
      .map(normalize)
      .filter((tag) => !selected.has(tag))
      .filter((tag) => !inputN || tag.includes(inputN));
  }, [suggestedTags, selected, inputN]);

  const showCreate =
    inputN.length > 0 &&
    !selected.has(inputN) &&
    !options.some(option => option.tag === inputN);

  const addTag = (tag: string) => {
    const n = normalize(tag);
    if (!n) return;
    if (selected.has(n)) return;
    onChange([...value, n]);
    setInput("");
  };

  const removeTag = (tag: string) => {
    const n = normalize(tag);
    onChange(value.filter(existing => normalize(existing) !== n));
  };

  const handleKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter" && showCreate) {
      event.preventDefault();
      addTag(input);
    }
    if (event.key === "Backspace" && !input && value.length) {
      removeTag(value[value.length - 1]);
    }
  };

  return (
    <div className={cn("flex flex-wrap items-center gap-1", className)}>
      {value.map(tag => (
        <TagChip key={tag} tag={tag} onRemove={() => removeTag(tag)} />
      ))}
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button
            ref={triggerRef}
            type="button"
            size="sm"
            variant="outline"
            className={cn(
              "h-7 gap-1 px-2 text-xs font-normal text-muted-foreground hover:text-foreground",
              size === "default" && "h-8 px-2.5",
            )}
          >
            <Tag className="h-3 w-3" />
            {value.length ? "Edit tags" : placeholder}
          </Button>
        </PopoverTrigger>
        <PopoverContent
          className="w-[260px] p-0"
          align="start"
          onOpenAutoFocus={(event: Event) => event.preventDefault()}
        >
          <Command shouldFilter={false}>
            <CommandInput
              value={input}
              onValueChange={setInput}
              onKeyDown={handleKeyDown}
              placeholder="Search or create tag..."
            />
            <CommandList>
              <CommandEmpty>No matching tags.</CommandEmpty>
              {quote && (suggestLoading || suggestError || aiSuggestions.length > 0) && (
                <CommandGroup heading="Suggested by AI">
                  {suggestLoading && (
                    <div className="flex items-center gap-2 px-2 py-1.5 text-xs text-muted-foreground">
                      <Loader2 className="h-3 w-3 animate-spin" />
                      Asking the chat model…
                    </div>
                  )}
                  {!suggestLoading && suggestError && (
                    <div className="px-2 py-1.5 text-xs text-amber-600 dark:text-amber-400">
                      {suggestError}
                    </div>
                  )}
                  {!suggestLoading && aiSuggestions.map((tag) => {
                    const known = options.find((o) => o.tag === tag);
                    return (
                      <CommandItem
                        key={`ai:${tag}`}
                        value={`ai:${tag}`}
                        onSelect={() => addTag(tag)}
                      >
                        <Sparkles className="h-3 w-3 text-foreground" />
                        <span className="flex-1 truncate">{tag}</span>
                        {known && (
                          <span className="text-xs tabular-nums text-muted-foreground">{known.count}</span>
                        )}
                      </CommandItem>
                    );
                  })}
                </CommandGroup>
              )}
              {showCreate && (
                <CommandGroup heading="New">
                  <CommandItem value={`__create__${inputN}`} onSelect={() => addTag(input)}>
                    <Plus className="h-3.5 w-3.5" />
                    Add &ldquo;{inputN}&rdquo;
                  </CommandItem>
                </CommandGroup>
              )}
              {suggestions.length > 0 && (
                <CommandGroup heading="Existing">
                  {suggestions.map(option => (
                    <CommandItem
                      key={option.tag}
                      value={option.tag}
                      onSelect={() => addTag(option.tag)}
                    >
                      <Tag className="h-3 w-3 text-muted-foreground" />
                      <span className="flex-1 truncate">{option.tag}</span>
                      <span className="text-xs tabular-nums text-muted-foreground">{option.count}</span>
                    </CommandItem>
                  ))}
                </CommandGroup>
              )}
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>
    </div>
  );
}

export function TagChip({
  tag,
  onRemove,
  onClick,
  variant = "secondary",
}: {
  tag: string;
  onRemove?: () => void;
  onClick?: () => void;
  variant?: "secondary" | "outline";
}) {
  return (
    <Badge
      variant={variant}
      className={cn(
        "gap-1 px-1.5 py-0.5 font-mono text-[11px]",
        onClick && "cursor-pointer hover:bg-secondary/80",
      )}
      onClick={onClick}
    >
      <span className="truncate">{tag}</span>
      {onRemove && (
        <button
          type="button"
          aria-label={`Remove tag ${tag}`}
          onClick={event => {
            event.stopPropagation();
            onRemove();
          }}
          className="-mr-0.5 inline-flex h-3 w-3 items-center justify-center rounded-sm hover:bg-foreground/10"
        >
          <X className="h-2.5 w-2.5" />
        </button>
      )}
    </Badge>
  );
}
