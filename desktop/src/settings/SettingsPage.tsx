import { YouTubeSettings } from "../tools/YouTubeSettings.tsx";
import { useEffect, useState } from "react";
import { AudioLines, Check, CircleAlert, Cpu, FolderOpen, HardDrive, Info, Palette, RefreshCw } from "lucide-react";
import { api } from "../lib/ipc.ts";
import { count } from "../lib/format.ts";
import type { Runtime } from "../lib/types.ts";
import { THEMES, themeLabel, useAppearance, type ReadingFont, type ReadingSize, type ThemeMode } from "../theme/theme.ts";
import type { SettingsSection } from "../lib/router.ts";
import { Button } from "../ui/Button.tsx";
import { Chip } from "../ui/Chip.tsx";
import { Segmented } from "../ui/Segmented.tsx";
import { Select } from "../ui/Select.tsx";
import { PageHeader } from "../ui/PageHeader.tsx";
import { useToast } from "../ui/Toasts.tsx";
import { useApp } from "../shell/AppContext.tsx";
import "./settings.css";
import { SpeechSetup } from "./SpeechSetup.tsx";
import { ProviderSettings } from "../ai/ProviderSettings.tsx";

function Section({ id, icon: Icon, title, children }: { id: SettingsSection; icon: typeof Palette; title: string; children: React.ReactNode }) {
  return (
    <section className="settings-section" id={`settings-${id}`}>
      <header>
        <span className="settings-icon">
          <Icon size={17} aria-hidden />
        </span>
        <h2>{title}</h2>
      </header>
      <div className="settings-body">{children}</div>
    </section>
  );
}

function Row({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="settings-row">
      <div className="settings-row-text">
        <span>{label}</span>
        {hint && <small>{hint}</small>}
      </div>
      <div className="settings-row-control">{children}</div>
    </div>
  );
}

export function SettingsPage({ section }: { section?: SettingsSection }) {
  const { overview, device, setDevice, importLegacy } = useApp();
  const toast = useToast();
  const [appearance, setAppearance] = useAppearance();
  const [runtime, setRuntime] = useState<Runtime>();
  const [checking, setChecking] = useState(false);
  const [version, setVersion] = useState("");
  const check = async () => {
    setChecking(true);
    try {
      setRuntime(await api.speechStatus());
    } catch (e) {
      toast.error(e);
    } finally {
      setChecking(false);
    }
  };
  useEffect(() => {
    void check();
    api
      .version()
      .then(setVersion)
      .catch(() => setVersion(""));
    // Checking once on open is enough; "Check again" re-runs it.
  }, []);
  // Links such as #/settings?section=speech open at that section and briefly mark it.
  useEffect(() => {
    if (!section) return;
    const el = document.getElementById(`settings-${section}`);
    if (!el) return;
    el.scrollIntoView({ block: "start" });
    el.classList.add("is-linked");
    const timer = setTimeout(() => el.classList.remove("is-linked"), 1600);
    return () => clearTimeout(timer);
  }, [section]);
  const fact = (ok: boolean | undefined, label: string) => (
    <span className="settings-fact">
      {ok ? <Check size={15} className="is-ok" aria-hidden /> : <CircleAlert size={15} className="is-warn" aria-hidden />}
      {label}
    </span>
  );
  return (
    <div className="settings-page">
      <PageHeader title="Settings" />
      <Section id="appearance" icon={Palette} title="Appearance">
        <Row label="Theme" hint="Concord's own look, or one of your imported themes.">
          <Select
            label="Theme"
            value={appearance.theme}
            onChange={(theme) => setAppearance({ ...appearance, theme })}
            options={THEMES.map((t) => ({ value: t, label: t === "concord" ? "Concord (default)" : themeLabel(t) }))}
          />
        </Row>
        <Row label="Mode">
          <Segmented<ThemeMode>
            label="Mode"
            value={appearance.mode}
            onChange={(mode) => setAppearance({ ...appearance, mode })}
            options={[
              { value: "system", label: "System" },
              { value: "dark", label: "Dark" },
              { value: "light", label: "Light" },
            ]}
          />
        </Row>
        <Row label="Transcript text" hint="The typeface used for transcripts and documents.">
          <Segmented<ReadingFont>
            label="Transcript text"
            value={appearance.reading}
            onChange={(reading) => setAppearance({ ...appearance, reading })}
            options={[
              { value: "serif", label: "Serif" },
              { value: "sans", label: "Sans" },
            ]}
          />
        </Row>
        <Row label="Transcript size">
          <Segmented<ReadingSize>
            label="Transcript size"
            value={appearance.size}
            onChange={(size) => setAppearance({ ...appearance, size })}
            options={[
              { value: "s", label: "Small" },
              { value: "m", label: "Medium" },
              { value: "l", label: "Large" },
            ]}
          />
        </Row>
        <p className="settings-preview">“The words that matter, right where you left them.”</p>
      </Section>

      <div id="settings-ai" className="settings-anchor">
        <ProviderSettings />
      </div>
      <div id="settings-youtube" className="settings-anchor">
        <YouTubeSettings />
      </div>
      <Section id="speech" icon={AudioLines} title="Speech">
        <Row label="Status">
          <Chip tone={runtime ? (runtime.ready ? "success" : "warn") : "neutral"}>{runtime ? (runtime.ready ? "Ready" : "Setup needed") : "Checking…"}</Chip>
        </Row>
        <Row label="Process recordings on" hint="Nemotron 3.5 multilingual transcription with Nemotron diarization.">
          <Select
            label="Processing device"
            value={device}
            onChange={setDevice}
            options={[
              { value: "auto", label: "Automatic · GPU when available" },
              { value: "cpu", label: "CPU" },
              ...(runtime?.device === "vulkan:0" ? [{ value: "vulkan:0", label: "GPU · Vulkan" }] : []),
            ]}
          />
        </Row>
        <div className="settings-facts">
          <span className="settings-fact">
            <Cpu size={15} aria-hidden />
            {!runtime ? "Checking compute devices…" : runtime.runtimeReady === false ? "Compute device check failed" : device === "cpu" || runtime.device === "cpu" ? "Selected processing: CPU" : `Selected processing: GPU · ${runtime.gpu || "Vulkan"}`}
          </span>
          {fact(runtime?.runtimeReady ?? runtime?.ready, `Speech runtime ${(runtime?.runtimeReady ?? runtime?.ready) ? "ready" : "unavailable"}`)}
          {fact(runtime?.modelsReady, `Speech models ${runtime?.modelsReady ? "available" : "missing"}`)}
          {fact(runtime?.voiceMatchingReady, `Voice matching ${runtime?.voiceMatchingReady ? "available" : "missing"}`)}
        </div>
        {runtime && !runtime.ready && (
          <p className="settings-note">
            {runtime.runtimeError || (!runtime.modelsReady ? "Speech models are missing. Prepare speech below to install them." : !runtime.voiceMatchingReady ? "Voice matching needs setup. Prepare speech below to install its environment." : "Speech setup needs attention. Check the runtime diagnostics in Status & Health.")}
          </p>
        )}
        <SpeechSetup managed={!!runtime?.managed} onComplete={() => void check()} />
        <div>
          <Button icon={RefreshCw} disabled={checking} onClick={() => void check()}>
            Check again
          </Button>
        </div>
      </Section>

      <Section id="library" icon={HardDrive} title="Library">
        <Row label="Library folder" hint="Concord Next keeps its own database and new transcripts here. Imported recordings stay where they are.">
          <code className="settings-path">{overview?.dataRoot}</code>
        </Row>
        <div className="settings-facts">
          <span className="settings-fact num">{count(overview?.media ?? 0, "recording")}</span>
          <span className="settings-fact num">{count(overview?.speakers ?? 0, "saved voice")}</span>
          <span className="settings-fact num">{count(overview?.notes ?? 0, "note")}</span>
          <span className="settings-fact num">{count(overview?.docs ?? 0, "document")}</span>
        </div>
        <Row label="Import a Concord library" hint="Available for an empty library, so existing edits stay safe.">
          <Button icon={FolderOpen} disabled={!!overview?.media} onClick={() => void importLegacy()}>
            Choose database…
          </Button>
        </Row>
      </Section>

      <Section id="about" icon={Info} title="About">
        <p className="settings-note">
          Concord Next{version && ` ${version}`}. Your library is stored on this computer. When you use a remote embedding or chat provider, the text needed for that request is sent to the provider you choose. Discover sends your online search query to Google.
        </p>
      </Section>
    </div>
  );
}
