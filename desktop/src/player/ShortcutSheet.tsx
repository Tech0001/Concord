import { Dialog } from "../ui/Dialog.tsx";
import { Kbd } from "../ui/Kbd.tsx";

const GROUPS: [string, [string[], string][]][] = [
  [
    "Playback",
    [
      [["Space"], "Play or pause"],
      [["←", "→"], "Back or forward 10 seconds"],
      [["Shift", "←/→"], "Back or forward 1 minute"],
      [["↑", "↓"], "Previous or next line"],
      [["<", ">"], "Slower or faster"],
      [["M"], "Mute"],
      [["F"], "Full screen (video)"],
    ],
  ],
  [
    "Ranges",
    [
      [["Shift", "click"], "Extend the selection to a line"],
      [["I"], "Set range start at the playhead"],
      [["O"], "Set range end at the playhead"],
      [["P"], "Play the range"],
      [["L"], "Loop the range"],
      [["Esc"], "Clear the range"],
    ],
  ],
  [
    "Everywhere",
    [
      [["Ctrl", "F"], "Find in transcript"],
      [["Ctrl", "K"], "Search or jump to"],
      [["?"], "Show these shortcuts"],
    ],
  ],
];

export function ShortcutSheet({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange} title="Keyboard shortcuts" size="md">
      <div className="shortcut-groups">
        {GROUPS.map(([title, rows]) => (
          <section key={title}>
            <h4 className="menu-label">{title}</h4>
            <dl className="shortcut-list">
              {rows.map(([keys, label]) => (
                <div key={label}>
                  <dt>
                    {keys.map((k) => (
                      <Kbd key={k}>{k}</Kbd>
                    ))}
                  </dt>
                  <dd>{label}</dd>
                </div>
              ))}
            </dl>
          </section>
        ))}
      </div>
    </Dialog>
  );
}
