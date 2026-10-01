import { SPEAKER_COLORS } from "../lib/speakers.ts";
export function ColorPicker({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  return <div className="voice-colors" role="group" aria-label="Speaker color">
    {SPEAKER_COLORS.map(color => <button type="button" key={color} aria-label={`Color ${color}`} aria-pressed={value === color}
      style={{ background: color }} onClick={() => onChange(color)} />)}
  </div>;
}
