import { useCallback, useEffect, useState } from "react";
import {
  AudioLines,
  Check,
  CircleAlert,
  Cpu,
  DatabaseBackup,
  Download,
  FolderOpen,
  HardDrive,
  Info,
  Palette,
  RefreshCw,
  Save,
  Sparkles,
} from "lucide-react";
import { api } from "../lib/ipc.ts";
import { count } from "../lib/format.ts";
import type { Runtime } from "../lib/types.ts";
import {
  THEMES,
  themeLabel,
  useAppearance,
  type ReadingFont,
  type ReadingSize,
  type ThemeMode,
} from "../theme/theme.ts";
import type { SettingsSection } from "../lib/router.ts";
import type { AutomaticAi, PipelineConfig } from "../pipeline/types.ts";
import { AutomaticSetup } from "../pipeline/AutomaticAi.tsx";
import { ProviderSettings } from "../ai/ProviderSettings.tsx";
import { Button } from "../ui/Button.tsx";
import { Chip } from "../ui/Chip.tsx";
import { Segmented } from "../ui/Segmented.tsx";
import { Select } from "../ui/Select.tsx";
import { PageHeader } from "../ui/PageHeader.tsx";
import { useToast } from "../ui/Toasts.tsx";
import { useApp } from "../shell/AppContext.tsx";
import { SpeechSetup } from "./SpeechSetup.tsx";
import { DownloadSettings } from "./DownloadSettings.tsx";
import "../pipeline/pipeline.css";
import "./settings.css";

const TABS: { id: SettingsSection; label: string; icon: typeof Palette }[] = [
  { id: "general", label: "General", icon: Palette },
  { id: "ai", label: "AI & Search", icon: Sparkles },
  { id: "speech", label: "Speech", icon: AudioLines },
  { id: "downloads", label: "Downloads & Schedule", icon: Download },
];

function Section({
  icon: Icon,
  title,
  actions,
  children,
}: {
  icon: typeof Palette;
  title: string;
  actions?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="settings-section">
      <header>
        <span className="settings-icon">
          <Icon size={17} aria-hidden />
        </span>
        <h2>{title}</h2>
        {actions && <div className="settings-head-actions">{actions}</div>}
      </header>
      <div className="settings-body">{children}</div>
    </section>
  );
}

function Row({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
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

export function SettingsPage({ section = "general" }: { section?: SettingsSection }) {
  const { overview, device, setDevice, importLegacy, navigate } = useApp();
  const toast = useToast();
  const [appearance, setAppearance] = useAppearance();
  const [runtime, setRuntime] = useState<Runtime>();
  const [checking, setChecking] = useState(false);
  const [version, setVersion] = useState("");
  const [pipelineConfig, setPipelineConfig] = useState<PipelineConfig>();
  const [automatic, setAutomatic] = useState<AutomaticAi>();
  const [speechLang, setSpeechLang] = useState("auto");
  const [transcriptDir, setTranscriptDir] = useState("");
  const [savingSpeech, setSavingSpeech] = useState(false);

  const checkRuntime = useCallback(async () => {
    setChecking(true);
    try {
      setRuntime(await api.speechStatus());
    } catch (e) {
      toast.error(e);
    } finally {
      setChecking(false);
    }
  }, [toast]);

  const loadPipeline = useCallback(async () => {
    try {
      const [state, ai] = await Promise.all([
        api.pipelineState(),
        api.pipelineAiState(),
      ]);
      setPipelineConfig(state.config);
      setSpeechLang(state.config.speechLanguage);
      setTranscriptDir(state.config.transcriptDirectory ?? "");
      setAutomatic(ai);
    } catch (e) {
      toast.error(e);
    }
  }, [toast]);

  useEffect(() => {
    void checkRuntime();
    void loadPipeline();
    api
      .version()
      .then(setVersion)
      .catch(() => setVersion(""));
  }, [checkRuntime, loadPipeline]);

  const switchTab = (next: SettingsSection) =>
    navigate(
      { page: "settings", section: next === "general" ? undefined : next },
      { replace: true },
    );

  const saveSpeechPrefs = async () => {
    if (!pipelineConfig) return;
    setSavingSpeech(true);
    try {
      const next: PipelineConfig = {
        ...pipelineConfig,
        device,
        speechLanguage: speechLang.trim() || "auto",
        transcriptDirectory: transcriptDir.trim(),
      };
      await api.pipelineSaveConfig(next);
      setPipelineConfig(next);
      toast.success("Speech settings saved");
    } catch (e) {
      toast.error(e);
    } finally {
      setSavingSpeech(false);
    }
  };

  const changeDevice = (next: string) => {
    setDevice(next);
    if (pipelineConfig) {
      const updated = { ...pipelineConfig, device: next };
      setPipelineConfig(updated);
      void api.pipelineSaveConfig(updated).catch(() => {});
    }
  };

  const speechDirty =
    !!pipelineConfig &&
    (speechLang !== pipelineConfig.speechLanguage ||
      transcriptDir !== (pipelineConfig.transcriptDirectory ?? ""));

  const fact = (ok: boolean | undefined, label: string) => (
    <span className="settings-fact">
      {ok ? (
        <Check size={15} className="is-ok" aria-hidden />
      ) : (
        <CircleAlert size={15} className="is-warn" aria-hidden />
      )}
      {label}
    </span>
  );

  return (
    <div className="settings-page">
      <PageHeader title="Settings" />

      <nav className="page-tabs" role="tablist" aria-label="Settings sections">
        {TABS.map((t) => {
          const Icon = t.icon;
          return (
            <button
              key={t.id}
              type="button"
              role="tab"
              aria-selected={section === t.id}
              className="page-tab"
              onClick={() => switchTab(t.id)}
            >
              <Icon size={15} aria-hidden />
              <span>{t.label}</span>
            </button>
          );
        })}
      </nav>

      {section === "general" && (
        <>
          <Section icon={Palette} title="Appearance">
            <Row
              label="Theme"
              hint="Concord's own look, or one of your imported themes."
            >
              <Select
                label="Theme"
                value={appearance.theme}
                onChange={(theme) => setAppearance({ ...appearance, theme })}
                options={THEMES.map((t) => ({
                  value: t,
                  label: t === "concord" ? "Concord (default)" : themeLabel(t),
                }))}
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
            <Row
              label="Transcript text"
              hint="The typeface used for transcripts and documents."
            >
              <Segmented<ReadingFont>
                label="Transcript text"
                value={appearance.reading}
                onChange={(reading) =>
                  setAppearance({ ...appearance, reading })
                }
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
            <p className="settings-preview">
              “The words that matter, right where you left them.”
            </p>
          </Section>

          <Section icon={HardDrive} title="Library">
            <Row
              label="Library folder"
              hint="Concord Next keeps its database here. External recordings and transcripts stay in your chosen folders."
            >
              <code className="settings-path">{overview?.dataRoot}</code>
            </Row>
            <div className="settings-facts">
              <span className="settings-fact num">
                {count(overview?.media ?? 0, "recording")}
              </span>
              <span className="settings-fact num">
                {count(overview?.speakers ?? 0, "saved voice")}
              </span>
              <span className="settings-fact num">
                {count(overview?.notes ?? 0, "note")}
              </span>
              <span className="settings-fact num">
                {count(overview?.docs ?? 0, "document")}
              </span>
            </div>
            <Row
              label="Database backups"
              hint="Create or restore a backup of your library database and settings."
            >
              <Button
                icon={DatabaseBackup}
                onClick={() => navigate({ page: "activity", tab: "backups" })}
              >
                Open Backups
              </Button>
            </Row>
            <Row
              label="Import a Concord library"
              hint="Available for an empty library, so existing edits stay safe."
            >
              <Button
                icon={FolderOpen}
                disabled={!!overview?.media}
                onClick={() => void importLegacy()}
              >
                Choose database…
              </Button>
            </Row>
          </Section>

          <Section icon={Info} title="About">
            <p className="settings-note">
              Concord Next{version && ` ${version}`}. Your library is stored on
              this computer. When you use a remote embedding or chat provider,
              only the text needed for that request is sent to the provider you
              choose.
            </p>
          </Section>
        </>
      )}

      {section === "ai" && (
        <>
          <ProviderSettings onChanged={() => void loadPipeline()} />
          {automatic && (
            <AutomaticSetup state={automatic} onChanged={loadPipeline} />
          )}
        </>
      )}

      {section === "speech" && (
        <Section
          icon={AudioLines}
          title="Speech & Transcription"
          actions={
            <>
              <Chip
                tone={
                  runtime ? (runtime.ready ? "success" : "warn") : "neutral"
                }
              >
                {runtime
                  ? runtime.ready
                    ? "Ready"
                    : "Setup needed"
                  : "Checking…"}
              </Chip>
              <Button
                size="sm"
                variant="ghost"
                icon={RefreshCw}
                disabled={checking}
                onClick={() => void checkRuntime()}
              >
                Check again
              </Button>
            </>
          }
        >
          <Row
            label="Process recordings on"
            hint="Nemotron 3.5 multilingual transcription and diarization."
          >
            <Select
              label="Processing device"
              value={device}
              onChange={changeDevice}
              options={[
                { value: "auto", label: "Automatic · GPU when available" },
                { value: "cpu", label: "CPU" },
                ...(runtime?.device === "vulkan:0" || device === "vulkan:0"
                  ? [{ value: "vulkan:0", label: "GPU · Vulkan" }]
                  : []),
              ]}
            />
          </Row>

          <div className="settings-facts">
            <span className="settings-fact">
              <Cpu size={15} aria-hidden />
              {!runtime
                ? "Checking compute devices…"
                : runtime.runtimeReady === false
                  ? "Compute device check failed"
                  : device === "cpu" || runtime.device === "cpu"
                    ? "Selected processing: CPU"
                    : `Selected processing: GPU · ${runtime.gpu || "Vulkan"}`}
            </span>
            {fact(
              runtime?.runtimeReady ?? runtime?.ready,
              `Speech runtime ${(runtime?.runtimeReady ?? runtime?.ready) ? "ready" : "unavailable"}`,
            )}
            {fact(
              runtime?.modelsReady,
              `Speech models ${runtime?.modelsReady ? "available" : "missing"}`,
            )}
            {fact(
              runtime?.voiceMatchingReady,
              `Voice matching ${runtime?.voiceMatchingReady ? "available" : "missing"}`,
            )}
          </div>

          {runtime && !runtime.ready && (
            <p className="settings-note">
              {runtime.runtimeError ||
                (!runtime.modelsReady
                  ? "Speech models are missing. Prepare speech below to install them."
                  : !runtime.voiceMatchingReady
                    ? "Voice matching needs setup. Prepare speech below to install its environment."
                    : "Speech setup needs attention. Check runtime diagnostics in Activity → Logs.")}
            </p>
          )}

          {pipelineConfig && (
            <div className="settings-divider-block">
              <Row
                label="Transcription language"
                hint="Use auto for automatic detection, or a language code such as en."
              >
                <input
                  className="input settings-short-input"
                  aria-label="Transcription language"
                  value={speechLang}
                  onChange={(e) => setSpeechLang(e.target.value)}
                />
              </Row>

              <label className="field">
                <span>Save transcripts in · a folder for each channel</span>
                <div className="pipeline-path">
                  <input
                    className="input"
                    aria-label="Transcripts folder"
                    placeholder="Not chosen yet · Concord’s own transcripts folder"
                    value={transcriptDir}
                    onChange={(e) => setTranscriptDir(e.target.value)}
                  />
                  <Button
                    icon={FolderOpen}
                    onClick={() =>
                      void api
                        .pickFolder("Choose where transcripts are saved")
                        .then((p) => p && setTranscriptDir(p))
                        .catch(toast.error)
                    }
                  >
                    Browse
                  </Button>
                </div>
                <small>
                  Each transcript is saved as a Markdown file with its timings
                  beside it. Re-transcribing replaces it safely once ready.
                </small>
              </label>

              <div>
                <Button
                  variant={speechDirty ? "primary" : "secondary"}
                  icon={Save}
                  disabled={savingSpeech || !speechDirty}
                  onClick={() => void saveSpeechPrefs()}
                >
                  Save speech settings
                </Button>
              </div>
            </div>
          )}

          <SpeechSetup
            managed={!!runtime?.managed}
            onComplete={() => void checkRuntime()}
          />
        </Section>
      )}

      {section === "downloads" && (
        <DownloadSettings
          config={pipelineConfig}
          onSave={async (next) => {
            const merged = { ...next, device };
            await api.pipelineSaveConfig(merged);
            await loadPipeline();
          }}
        />
      )}
    </div>
  );
}
