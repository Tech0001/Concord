import type { CSSProperties } from "react";
import type { Category } from "../lib/types.ts";
import { THEME_ACCENTS, THEMES, themeLabel, useAppearance, type ReadingFont, type ReadingSize, type ThemeMode } from "../theme/theme.ts";
import { Segmented } from "../ui/Segmented.tsx";
import { useApp } from "../shell/AppContext.tsx";
import { SetupFoot, SetupHead } from "./parts.tsx";
import type { StepProps } from "./steps.ts";

const LINES = [
  { time: "14:02", name: "Host", color: "var(--chart-1)", text: "So where did the idea for the community garden actually start?" },
  { time: "14:09", name: "Guest", color: "var(--chart-2)", text: "Honestly, with a vacant lot and a few neighbors who were tired of looking at it.", current: true },
  { time: "14:21", name: "", color: "var(--chart-2)", text: "We asked the city for a one-year lease, and nobody expected them to say yes." },
];

export function LookStep({ next, back, detour }: StepProps) {
  const [appearance, setAppearance] = useAppearance();
  const { category, setCategory } = useApp();
  return (
    <>
      <div className="setup-content">
        <SetupHead eyebrow={detour ? "Look & feel" : "Step 5 of 5 · Optional"} title="Make it yours">
          Change any of this later in Settings › Appearance.
        </SetupHead>
        <div className="setup-look">
          <div className="setup-look-controls">
            <section className="setup-section">
              <span className="setup-label">Appearance</span>
              <Segmented<ThemeMode>
                label="Appearance"
                value={appearance.mode}
                onChange={(mode) => setAppearance({ ...appearance, mode })}
                options={[
                  { value: "light", label: "Light" },
                  { value: "dark", label: "Dark" },
                  { value: "system", label: "Match system" },
                ]}
              />
            </section>
            <section className="setup-section">
              <span className="setup-label" id="theme-label">
                Theme
              </span>
              <div className="setup-swatches" role="radiogroup" aria-labelledby="theme-label">
                {THEMES.map((theme) => (
                  <button
                    key={theme}
                    type="button"
                    role="radio"
                    aria-checked={appearance.theme === theme}
                    className="setup-swatch"
                    title={themeLabel(theme)}
                    onClick={() => setAppearance({ ...appearance, theme })}
                  >
                    <span className="setup-swatch-dot" style={{ "--swatch": THEME_ACCENTS[theme] ?? "var(--primary)" } as CSSProperties} />
                    <span>{themeLabel(theme)}</span>
                  </button>
                ))}
              </div>
            </section>
            <div className="setup-look-pair">
              <section className="setup-section">
                <span className="setup-label">Transcript text</span>
                <Segmented<ReadingFont>
                  label="Transcript text"
                  value={appearance.reading}
                  onChange={(reading) => setAppearance({ ...appearance, reading })}
                  options={[
                    { value: "serif", label: "Serif" },
                    { value: "sans", label: "Sans" },
                  ]}
                />
              </section>
              <section className="setup-section">
                <span className="setup-label">Size</span>
                <Segmented<ReadingSize>
                  label="Transcript size"
                  value={appearance.size}
                  onChange={(size) => setAppearance({ ...appearance, size })}
                  options={[
                    { value: "s", label: "S" },
                    { value: "m", label: "M" },
                    { value: "l", label: "L" },
                  ]}
                />
              </section>
            </div>
            <section className="setup-section">
              <span className="setup-label">Show by default</span>
              <Segmented<Category>
                label="Show by default"
                value={category}
                onChange={setCategory}
                options={[
                  { value: "personal", label: "Personal" },
                  { value: "work", label: "Work" },
                  { value: "", label: "Both" },
                ]}
              />
              <small className="muted">Switch any time from the top bar.</small>
            </section>
          </div>
          <section className="setup-section" aria-label="Preview">
            <span className="setup-label">Preview</span>
            <div className="setup-preview">
              <div className="setup-preview-head">
                <i aria-hidden />
                Community garden interview
                <span className="num">14:09 / 52:31</span>
              </div>
              <div className="setup-preview-lines">
                {LINES.map((line) => (
                  <div key={line.time} className={line.current ? "setup-preview-line is-current" : "setup-preview-line"} style={{ "--speaker": line.color } as CSSProperties}>
                    <time>{line.time}</time>
                    <span>
                      {line.name && <b>{line.name}</b>}
                      <p>{line.text}</p>
                    </span>
                  </div>
                ))}
              </div>
            </div>
          </section>
        </div>
      </div>
      <SetupFoot back={back} primary={{ label: detour ? "Done" : "Finish setup", onClick: next }} />
    </>
  );
}
