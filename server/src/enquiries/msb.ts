/* A FINTRAC money services business registration number, as an
   applicant types it on Early Access v2.1 (CD-179).

   Optional. Upper-cased, spaces and hyphens taken out, and the M added
   when it was left off: "m 1234-5678" and "12345678" are both
   M12345678. Empty means they did not give one. Anything else is not an
   MSB number, and the page says so: "An MSB number is M followed by 8
   digits. Leave it empty if you don't have it yet." */
export type MsbResult = { ok: true; value: string | null } | { ok: false };

export function normalizeMsb(raw: unknown): MsbResult {
  if (raw === null || raw === undefined) return { ok: true, value: null };
  const compact = String(raw).toUpperCase().replace(/[\s-]+/g, "");
  if (!compact) return { ok: true, value: null };
  const match = /^M?(\d{8})$/.exec(compact);
  return match ? { ok: true, value: `M${match[1]}` } : { ok: false };
}
