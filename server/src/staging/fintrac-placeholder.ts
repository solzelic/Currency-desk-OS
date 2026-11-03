/* The demo seed's FINTRAC number (server/src/seed.ts). Exact match only. It
   counts as "no number" for the staging reset only on the seed's own shop,
   and no report can ever be filed under it (#609 PR B). */
export const SEED_PLACEHOLDER_FINTRAC = "M12345678";

export function fintracNumberFileable(value: string | null | undefined): boolean {
  return value !== SEED_PLACEHOLDER_FINTRAC;
}
