/** Desktop hosts supply a picker; the standalone web server uses OS helpers. */
export interface PickerOpts {
  prompt: string;
  defaultPath?: string;
}

export interface PickerResult {
  path?: string;
  cancelled?: boolean;
}

export type NativePicker = (kind: "directory" | "file", opts: PickerOpts) => Promise<PickerResult>;
