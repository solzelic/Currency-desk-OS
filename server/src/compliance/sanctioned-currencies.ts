/* Currencies of sanctioned countries must not be offered as a desk's
   home currency.

   A sourced list and lookup is landing in a parallel change. This file
   is the plug that change connects to. It does not contain a list, and
   it must not grow one: a hardcoded set would go stale the day it was
   typed, and a currency refused here is a currency a desk cannot keep
   its books in.

   Until that module assigns a lookup, every code is allowed.

   Plug-in, from the module that owns the list:

     import { setSanctionedCurrencyLookup } from "./sanctioned-currencies.js";
     setSanctionedCurrencyLookup((code) => list.has(code));

   `code` is an uppercase ISO 4217 currency. Return true when that
   currency belongs to a sanctioned jurisdiction and must not be
   selectable. The home-currency change calls `isSanctionedCurrency`
   before it accepts a code, and the Settings picker hides whatever
   this returns true for. Both sides use this function. Neither side
   has its own list. */
export type SanctionedCurrencyLookup = (code: string) => boolean | Promise<boolean>;

let lookup: SanctionedCurrencyLookup = () => false;

/** Install the sourced lookup. Pass `() => false` to clear it. */
export function setSanctionedCurrencyLookup(next: SanctionedCurrencyLookup): void {
  lookup = next;
}

/** True when this currency must not be selected as a home currency. */
export async function isSanctionedCurrency(code: string): Promise<boolean> {
  const normalized = code.trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(normalized)) return false;
  return lookup(normalized);
}
