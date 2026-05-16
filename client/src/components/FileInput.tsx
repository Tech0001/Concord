import { useState } from "react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { FileSearch, Loader2 } from "lucide-react";
import { useToast } from "@/hooks/use-toast";

export interface FileInputProps {
  id?: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  /** Title shown in the macOS file dialog. */
  prompt?: string;
  className?: string;
}

/**
 * Sibling of FolderInput. Routes through /api/dialog/pick-file (AppleScript
 * `choose file` on macOS). The user can also type/paste a path manually.
 * On Linux/Windows the server returns 501; we surface that as a toast and
 * leave the text input as the only option until those platforms get a
 * native picker.
 */
export default function FileInput({
  id,
  value,
  onChange,
  placeholder,
  prompt,
  className,
}: FileInputProps) {
  const [picking, setPicking] = useState(false);
  const { toast } = useToast();

  const pick = async () => {
    setPicking(true);
    try {
      const res = await fetch("/api/dialog/pick-file", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt, defaultPath: value || undefined }),
      });
      const data = await res.json();
      if (res.status === 501) {
        toast({
          title: "File picker unavailable",
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
      onChange(data.path);
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
        aria-label="Browse for file"
        className="h-8 w-8 shrink-0"
      >
        {picking
          ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
          : <FileSearch className="h-3.5 w-3.5" />}
      </Button>
    </div>
  );
}
