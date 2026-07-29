/* ============================================================
   Address lookup — Google Places, from the server.

   The key never goes to the browser. A Places key in a public page is
   a key anybody can lift and spend, and restricting it by referrer is a
   speed bump rather than a lock. So the page asks us, and we ask Google.

   That also means only somebody holding a real invite code can spend
   our quota: these are reached through /api/onboarding/:ref/…, behind
   the same check as everything else on that page.

   Without GOOGLE_PLACES_API_KEY nothing breaks. `enabled` comes back
   false, the page never shows a dropdown, and the address is typed by
   hand exactly as it is today.
   ============================================================ */

const ENDPOINT = "https://places.googleapis.com/v1";

export const placesEnabled = (): boolean => !!process.env.GOOGLE_PLACES_API_KEY;

export interface Suggestion { id: string; primary: string; secondary: string }

export interface Address {
  street: string;
  city: string;
  region: string;
  postal: string;
  country: string;
}

/* Google's own session semantics: the keystrokes that lead to one chosen
   address are billed as a session rather than per request, but only if the
   same token is sent throughout and then with the details call. The page
   mints one per address it is filling in. */
async function call(path: string, body: unknown, fields: string): Promise<Record<string, unknown> | null> {
  const key = process.env.GOOGLE_PLACES_API_KEY;
  if (!key) return null;
  try {
    const res = await fetch(`${ENDPOINT}/${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "X-Goog-Api-Key": key,
        "X-Goog-FieldMask": fields,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(6000),
    });
    if (!res.ok) {
      console.error(`[places] ${path} ${res.status} ${await res.text().catch(() => "")}`);
      return null;
    }
    return (await res.json()) as Record<string, unknown>;
  } catch (err) {
    console.error("[places] failed", err);
    return null;
  }
}

/* What they have typed so far → a handful of addresses to choose from.
   Biased to the country they told us they are licensed in, because a desk
   in Toronto is not looking for a street in Ohio. */
export async function suggest(input: string, country: string | undefined, session: string): Promise<Suggestion[]> {
  if (input.trim().length < 3) return [];
  const body: Record<string, unknown> = {
    input,
    sessionToken: session,
    // street addresses, not restaurants
    includedPrimaryTypes: ["street_address", "premise", "subpremise", "route"],
  };
  if (country && /^[A-Z]{2}$/.test(country)) body.includedRegionCodes = [country.toLowerCase()];

  const out = await call("places:autocomplete", body, "*");
  const raw = (out?.suggestions ?? []) as Record<string, unknown>[];
  return raw
    .map((s) => (s.placePrediction ?? null) as Record<string, unknown> | null)
    .filter((p): p is Record<string, unknown> => !!p)
    .map((p) => {
      const fmt = (p.structuredFormat ?? {}) as Record<string, unknown>;
      const main = (fmt.mainText ?? {}) as { text?: string };
      const sec = (fmt.secondaryText ?? {}) as { text?: string };
      return {
        id: String(p.placeId ?? ""),
        primary: main.text ?? String((p.text as { text?: string })?.text ?? ""),
        secondary: sec.text ?? "",
      };
    })
    .filter((s) => s.id && s.primary)
    .slice(0, 6);
}

/* Google returns an address as a bag of components. The desk wants five
   fields, so this is where the translation happens — once, here, rather
   than in the browser where it would be a second copy to keep in step. */
export async function details(placeId: string, session: string): Promise<Address | null> {
  const data = await getDetails(placeId, session);
  if (!data) return null;

  const comps = (data.addressComponents ?? []) as Record<string, unknown>[];
  const pick = (type: string, short = false): string => {
    const c = comps.find((x) => Array.isArray(x.types) && (x.types as string[]).includes(type));
    if (!c) return "";
    return String((short ? c.shortText : c.longText) ?? c.longText ?? "");
  };

  const number = pick("street_number");
  const route = pick("route");
  const street = [number, route].filter(Boolean).join(" ").trim();
  const city = pick("locality") || pick("postal_town") || pick("administrative_area_level_2");

  return {
    street,
    city,
    region: pick("administrative_area_level_1"),
    postal: pick("postal_code"),
    country: pick("country"),
  };
}

async function getDetails(placeId: string, session: string): Promise<Record<string, unknown> | null> {
  const key = process.env.GOOGLE_PLACES_API_KEY;
  if (!key) return null;
  try {
    const url = `${ENDPOINT}/places/${encodeURIComponent(placeId)}?sessionToken=${encodeURIComponent(session)}`;
    const res = await fetch(url, {
      headers: { "X-Goog-Api-Key": key, "X-Goog-FieldMask": "addressComponents,formattedAddress" },
      signal: AbortSignal.timeout(6000),
    });
    if (!res.ok) {
      console.error(`[places] details ${res.status} ${await res.text().catch(() => "")}`);
      return null;
    }
    return (await res.json()) as Record<string, unknown>;
  } catch (err) {
    console.error("[places] details failed", err);
    return null;
  }
}
