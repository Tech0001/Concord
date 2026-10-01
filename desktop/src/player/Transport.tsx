import { Keyboard, Pause, Play, RotateCcw, RotateCw, Volume2, VolumeX } from "lucide-react";
import { clock } from "../lib/format.ts";
import { useTime, type TimeStore } from "../lib/timeStore.ts";
import { PHONE, useMediaQuery } from "../lib/media-query.ts";
import { Button, IconButton } from "../ui/Button.tsx";
import { Menu } from "../ui/Menu.tsx";
import { RATES, type MediaControls } from "./useMedia.ts";

function Clock({ time, duration }: { time: TimeStore; duration: number }) {
  const t = useTime(time, Math.floor);
  return (
    <span className="transport-clock mono num">
      {clock(t)} <span className="muted">/ {clock(duration)}</span>
    </span>
  );
}

export function Transport({ controls, time, onShortcuts }: { controls: MediaControls; time: TimeStore; onShortcuts?: () => void }) {
  const phone = useMediaQuery(PHONE);
  const rateLabel = `${controls.rate}×`;
  return (
    <div className="transport">
      <button type="button" className="transport-play" disabled={!controls.ready} aria-label={controls.playing ? "Pause" : "Play"} onClick={() => controls.toggle()}>
        {controls.playing ? <Pause size={18} fill="currentColor" /> : <Play size={18} fill="currentColor" />}
      </button>
      <IconButton label="Back 10 seconds" icon={RotateCcw} disabled={!controls.ready} onClick={() => controls.skip(-10)} />
      <IconButton label="Forward 10 seconds" icon={RotateCw} disabled={!controls.ready} onClick={() => controls.skip(10)} />
      <Clock time={time} duration={controls.duration} />
      <span className="transport-spacer" />
      <Menu
        label="Playback speed"
        trigger={
          <Button variant="ghost" size="sm" className="transport-rate num" aria-label={`Playback speed ${rateLabel}`}>
            {rateLabel}
          </Button>
        }
        entries={RATES.map((r) => ({ label: `${r}×`, checked: r === controls.rate, onSelect: () => controls.setRate(r) }))}
      />
      <IconButton label={controls.muted ? "Unmute" : "Mute"} icon={controls.muted ? VolumeX : Volume2} onClick={() => controls.toggleMute()} />
      {!phone && (
        <input
          className="transport-volume"
          type="range"
          min={0}
          max={1}
          step={0.05}
          value={controls.muted ? 0 : controls.volume}
          aria-label="Volume"
          onChange={(e) => controls.setVolume(Number(e.target.value))}
        />
      )}
      {!phone && onShortcuts && <IconButton label="Keyboard shortcuts" icon={Keyboard} onClick={onShortcuts} />}
    </div>
  );
}
