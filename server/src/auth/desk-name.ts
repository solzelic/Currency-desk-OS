/* The name on a refusal is the one the menu already shows: an initial
   and a surname. The space between them does not break, so "S. Iqbal"
   stays on one line on a phone. "Amrit Singh" becomes "A. Singh".
   A single word is left as it was typed. */
export function pinDeskName(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length < 2) return name.trim();
  const first = parts[0]!.replace(/\.$/, "");
  const letter = first.charAt(0).toUpperCase();
  const surname = parts[parts.length - 1]!;
  return `${letter}.\u00A0${surname}`;
}
