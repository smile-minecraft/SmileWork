/** 依 Unicode code point 截斷，避免把中文或 emoji 切成半個字。 */
export function truncateText(text: string, maxChars: number): string {
  if (maxChars <= 0) return "";
  const characters = Array.from(text);
  if (characters.length <= maxChars) return text;
  return characters.slice(0, maxChars).join("");
}

export function textLength(text: string): number {
  return Array.from(text).length;
}
