import fs from "node:fs";
import path from "node:path";
import type { OpenDialogOptions, OpenDialogReturnValue } from "electron";
import type { NativePicker } from "../server/native-picker";

/** Electron supplies its native dialog on Linux too, without zenity/kdialog. */
export function createNativePicker(
  showDialog: (options: OpenDialogOptions) => Promise<OpenDialogReturnValue>,
): NativePicker {
  return async (kind, opts) => {
    let defaultPath = typeof opts.defaultPath === "string" && path.isAbsolute(opts.defaultPath)
      ? opts.defaultPath : undefined;
    // Saved output folders may not have been created yet. Open their nearest
    // existing parent, but let the dialog pick its default if the drive is gone.
    while (defaultPath && !fs.existsSync(defaultPath)) {
      const parent = path.dirname(defaultPath);
      defaultPath = parent === path.parse(parent).root ? undefined : parent;
    }
    const result = await showDialog({
      title: typeof opts.prompt === "string" ? opts.prompt : "Choose location",
      defaultPath,
      properties: kind === "directory" ? ["openDirectory", "createDirectory"] : ["openFile"],
    });
    return result.canceled || !result.filePaths[0]
      ? { cancelled: true } : { path: result.filePaths[0] };
  };
}
