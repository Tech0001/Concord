import { useState } from "react";
import { FolderOpen, Mic, Upload } from "lucide-react";
import { useApp } from "../shell/AppContext.tsx";
import { Button } from "../ui/Button.tsx";

/** A library with nothing in it yet: the page itself is the way in. */
export function LibraryStart() {
  const { chooseToAdd, openAdd, navigate } = useApp();
  const [link, setLink] = useState("");
  const add = (text: string) => {
    if (!text.trim()) return;
    openAdd({ text });
    setLink("");
  };
  return (
    <section className="library-start" aria-label="Add recordings">
      <span className="library-start-icon">
        <Upload size={22} aria-hidden />
      </span>
      <h2>Bring in your recordings</h2>
      <p>Drop audio or video files, or a whole folder, anywhere in this window. They're transcribed as soon as they arrive.</p>
      <div className="library-start-actions">
        <Button variant="primary" icon={Upload} onClick={() => void chooseToAdd("files")}>
          Choose files
        </Button>
        <Button icon={FolderOpen} onClick={() => void chooseToAdd("folder")}>
          Choose folder
        </Button>
        <Button variant="ghost" icon={Mic} onClick={() => navigate({ page: "tools", tab: "record" })}>
          Record
        </Button>
      </div>
      <div className="library-start-or">or paste a link</div>
      <form
        className="library-start-link"
        onSubmit={(e) => {
          e.preventDefault();
          add(link);
        }}
      >
        <input
          aria-label="Video or channel link"
          placeholder="A video or channel link"
          value={link}
          onChange={(e) => setLink(e.target.value)}
          onPaste={(e) => {
            // A text field would join several pasted lines into one; take them to Add as they are.
            const text = e.clipboardData.getData("text/plain");
            if (/\n/.test(text.trim())) {
              e.preventDefault();
              add(text);
            }
          }}
        />
        <Button type="submit" disabled={!link.trim()}>
          Add
        </Button>
      </form>
      <small>A video link adds that video. A channel link lets you follow it for new videos.</small>
    </section>
  );
}
