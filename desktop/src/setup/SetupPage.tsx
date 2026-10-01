import { AskHelp } from "../ai/ConcordHelp.tsx";
import { useEffect, useRef } from "react";
import { Check, ChevronLeft, CircleAlert, LoaderCircle, Minus } from "lucide-react";
import icon from "../../../assets/brand/concord-icon.svg";
import { api } from "../lib/ipc.ts";
import type { Route } from "../lib/router.ts";
import { themeLabel, useAppearance } from "../theme/theme.ts";
import { Button, IconButton } from "../ui/Button.tsx";
import { useToast } from "../ui/Toasts.tsx";
import { useApp } from "../shell/AppContext.tsx";
import { AiStep } from "./AiStep.tsx";
import { LibraryStep } from "./LibraryStep.tsx";
import { LookStep } from "./LookStep.tsx";
import { NUMBERED, STEP_LABEL, nextStep, previousStep, speechPercent, stepState, stepSummary } from "./model.ts";
import { Bar, Segments } from "./parts.tsx";
import { ReadyStep } from "./ReadyStep.tsx";
import { RecordingsStep } from "./RecordingsStep.tsx";
import { SpeechStep } from "./SpeechStep.tsx";
import type { StepProps } from "./steps.ts";
import type { SetupStep } from "./types.ts";
import "./setup.css";

type SetupRoute = Extract<Route, { page: "setup" }>;
const MODES = { dark: "Dark", light: "Light", system: "Matches system" };

export function SetupPage({ route }: { route: SetupRoute }) {
  const { setup, refreshSetup, navigate } = useApp();
  const toast = useToast();
  const [appearance] = useAppearance();
  const detour = route.returnTo;
  const requested = route.step ?? setup?.progress.step ?? "library";
  // The library choice is required; nothing else makes sense before it.
  const current: SetupStep = setup && !setup.library.started ? "library" : requested;
  const saved = useRef<string>("");
  useEffect(() => {
    if (!setup || detour || saved.current === current) return;
    saved.current = current;
    void api
      .setupSave({ step: current })
      .then(refreshSetup)
      .catch(toast.error);
  }, [current, setup, detour, refreshSetup, toast]);
  useEffect(() => {
    window.scrollTo(0, 0);
  }, [current]);

  if (!setup) return <div className="setup" aria-busy="true" />;

  const go = (step: SetupStep) => navigate({ page: "setup", step, ...(detour ? { returnTo: detour } : {}) });
  const leave = () => navigate(detour === "search" ? { page: "search", q: "" } : { page: detour ?? "library" });
  const next = async () => {
    const skipped = setup.progress.skipped;
    if (skipped.includes(current)) await api.setupSave({ skipped: skipped.filter((s) => s !== current) }).catch(toast.error);
    void refreshSetup();
    if (detour) leave();
    else go(nextStep(current));
  };
  const skip = async () => {
    await api.setupSave({ skipped: [...new Set([...setup.progress.skipped, current])] }).catch(toast.error);
    void refreshSetup();
    go(nextStep(current));
  };
  const finish = async () => {
    try {
      await api.setupSave({ completed: true });
      await refreshSetup();
      navigate({ page: "library" });
    } catch (e) {
      toast.error(e);
    }
  };
  const previous = previousStep(current);
  const look = `${themeLabel(appearance.theme)} · ${MODES[appearance.mode]}`;
  const props: StepProps = {
    status: setup,
    next: () => void next(),
    skip: detour ? null : () => void skip(),
    back: detour ? leave : previous ? () => go(previous) : null,
    go,
    finish: () => void finish(),
    detour: !!detour,
    chat: route.chat,
  };
  const position = NUMBERED.indexOf(current);
  return (
    <div className="setup" data-step={current}>
      <aside className="setup-rail">
        <div className="setup-brand">
          <img src={icon} alt="" width={30} height={30} />
          <b>Concord</b>
          <small>Setup</small>
        </div>
        <nav className="setup-steps" aria-label="Setup steps">
          {NUMBERED.map((step, i) => {
            const state = stepState(setup, step, current);
            return (
              <button
                key={step}
                type="button"
                className="setup-step"
                data-state={state}
                aria-current={state === "current" ? "step" : undefined}
                disabled={!setup.library.started && step !== "library"}
                onClick={() => go(step)}
              >
                <span className="setup-dot">
                  {state === "done" ? (
                    <Check size={13} strokeWidth={3} aria-hidden />
                  ) : state === "running" ? (
                    <LoaderCircle size={13} className="spin" aria-hidden />
                  ) : state === "failed" ? (
                    <CircleAlert size={13} aria-hidden />
                  ) : state === "skipped" ? (
                    <Minus size={13} aria-hidden />
                  ) : (
                    i + 1
                  )}
                </span>
                <span className="setup-step-text">
                  <span className="setup-step-label">{STEP_LABEL[step]}</span>
                  <span className="setup-step-sub">{stepSummary(setup, step, look)}</span>
                  {step === "speech" && state === "running" && <Bar pct={speechPercent(setup.speech.setup)} thin />}
                </span>
              </button>
            );
          })}
        </nav>
        <div className="setup-rail-foot">
          {current === "ready" ? null : !setup.library.started ? (
            "Only step 1 is required. Everything else can wait on your Library page."
          ) : detour ? (
            <button type="button" className="text-link" onClick={leave}>
              Back to {detour === "ai" ? "AI" : detour === "search" ? "Search" : detour === "settings" ? "Settings" : "Library"}
            </button>
          ) : (
            <button type="button" className="text-link" onClick={() => void finish()}>
              Finish setup later
            </button>
          )}
        </div>
      </aside>
      <div className="setup-main">
        <div className="setup-top">
          <div className="setup-top-row">
            <span className="setup-top-side">{props.back && <IconButton label="Back" icon={ChevronLeft} onClick={props.back} />}</span>
            <span className="setup-top-title">{current === "ready" ? "All set" : `Step ${position + 1} of 5`}</span>
            <span className="setup-top-side is-end">
              {current !== "ready" && setup.library.started && !detour && (
                <Button variant="ghost" onClick={() => void finish()}>
                  Later
                </Button>
              )}
            </span>
          </div>
          <Segments states={NUMBERED.map((step) => stepState(setup, step, current))} />
        </div>
        <div className="setup-help"><AskHelp topic={current} error={current === "speech" && setup.speech.setup.status === "failed" ? setup.speech.setup.message : undefined} /></div>
        {current === "library" ? (
          <LibraryStep {...props} />
        ) : current === "speech" ? (
          <SpeechStep {...props} />
        ) : current === "recordings" ? (
          <RecordingsStep {...props} />
        ) : current === "ai" ? (
          <AiStep {...props} />
        ) : current === "look" ? (
          <LookStep {...props} />
        ) : (
          <ReadyStep {...props} look={look} />
        )}
      </div>
    </div>
  );
}
