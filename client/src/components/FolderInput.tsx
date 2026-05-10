import { useState } from "react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { FolderOpen, Loader2 } from "lucide-react";
import { useToast } from "@/hooks/use-toast";

export interface FolderInputProps {
  id?: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  /** Title shown in the macOS folder dialog. */
  prompt?: string;
  /**
   * If set, auto-append this subfolder name to whatever the user picks
   * (e.g. pick "/Users/x/Docs" with appendSubfolder="saved_videos" →
   * value becomes "/Users/x/Docs/saved_videos"). Skipped if the picked
   * path already ends with that segment, so picking the same place twice
   * is idempotent. Manual typing is never modified.
   */
  appendSubfolder?: string;
  className?: string;
}

export default function FolderInput({
  id,
  value,
  onChange,
  placeholder,
  prompt,
  appendSubfolder,
  className,
}: FolderInputProps) {
  const [picking, setPicking] = useState(false);
  const { toast } = useToast();

  const pick = async () => {
    setPicking(true);
    try {
      const res = await fetch("/api/dialog/pick-folder", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt, defaultPath: value || undefined }),
      });
      const data = await res.json();
      if (res.status === 501) {
        toast({
          title: "Folder picker unavailable",
          description: data.error || "Type the path manually for now.",
          variant: "destructive",
        });
        return;
      }
      if (!res.ok) {
        toast({ title: "Picker failed", description: data.error || `HTTP ${res.status}`, variant: "destructive" });
        return;
      }
      if (data.cancelled) return;
      if (typeof data.path !== "string") return;
      let picked = data.path.replace(/\/+$/, "");
      if (appendSubfolder && !picked.endsWith(`/${appendSubfolder}`)) {
        picked = `${picked}/${appendSubfolder}`;
      }
      onChange(picked);
    } catch (err) {
      toast({ title: "Picker failed", description: String(err), variant: "destructive" });
    } finally {
      setPicking(false);
    }
  };

  return (
    <div className="flex gap-1">
      <Input
        id={id}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className={className}
      />
      <Button
        type="button"
        size="icon"
        variant="ghost"
        onClick={pick}
        disabled={picking}
        title="Browse…"
        aria-label="Browse for folder"
        className="h-8 w-8 shrink-0"
      >
        {picking
          ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
          : <FolderOpen className="h-3.5 w-3.5" />}
      </Button>
    </div>
  );
}
