import type { ChatChoice, SetupStatus, SetupStep } from "./types.ts";

/** What every setup screen receives from the setup page. */
export type StepProps = {
  status: SetupStatus;
  /** Continue to the next step, or back to where setup was opened from. */
  next: () => void;
  /** Skip this step; null when it cannot be skipped. */
  skip: (() => void) | null;
  back: (() => void) | null;
  go: (step: SetupStep) => void;
  /** Mark setup complete and open the Library. */
  finish: () => void;
  /** Setup was opened from another page for this one step. */
  detour: boolean;
  /** A chat provider to preselect on the Search & AI step. */
  chat?: ChatChoice;
};
