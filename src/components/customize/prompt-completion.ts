export function matchingPrompts(value: string, suggestions: readonly string[]): string[] {
  return suggestions.filter((suggestion) => suggestion.length > value.length && suggestion.toLowerCase().startsWith(value.toLowerCase()));
}

export function promptCompletionKey(
  event: { key: string; altKey: boolean; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean; isComposing: boolean },
  { value, selectionStart, selectionEnd }: { value: string; selectionStart: number; selectionEnd: number },
  matchCount: number,
): "accept" | "previous" | "next" | undefined {
  if (!matchCount || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || event.isComposing) return;
  if (event.key === "Tab") return "accept";
  if (selectionStart !== value.length || selectionEnd !== value.length) return;
  if (event.key === "ArrowRight") return "accept";
  if (matchCount > 1 && event.key === "ArrowUp") return "previous";
  if (matchCount > 1 && event.key === "ArrowDown") return "next";
}
