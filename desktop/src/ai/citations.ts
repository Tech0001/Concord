/** Keep original source numbers; never renumber a filtered list. Ignore code and link labels. */
export function citedNumbers(text: string, total: number): number[] {
  const prose = text.replace(/```[\s\S]*?```/g, "").replace(/`[^`]*`/g, "");
  return [
    ...new Set(
      [...prose.matchAll(/\[(\d+)\](?!\()/g)]
        .map((m) => Number(m[1]))
        .filter((n) => Number.isSafeInteger(n) && n > 0 && n <= total),
    ),
  ];
}
