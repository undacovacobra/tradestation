export function extractPosition(text: string): number | null {
  const match = text.replace(/,/g, "").match(/\bPOSITION\s+(-?\d+)\b/i);
  return match ? Number(match[1]) : null;
}
