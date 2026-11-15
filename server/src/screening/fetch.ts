import type { ListEntry } from "./match.js";
import type { ListSource } from "./sources.js";
import { LIST_SOURCES } from "./sources.js";
import { pgPool, rescreenAll } from "./gate.js";
import { latestGood, markUnchanged, sha256, storeFailed, storeGood, type SqlDb } from "./store.js";

export type FetchBody = (url: string) => Promise<{ ok: boolean; status: number; body: string }>;

const DAY_MS = 24 * 60 * 60 * 1000;

/** Official HTTPS hosts. A redirect to any other host fails the fetch. */
export const OFFICIAL_HTTPS_HOSTS = new Set([
  "www.international.gc.ca",
  "scsanctions.un.org",
  "www.publicsafety.gc.ca",
]);

/** A list larger than this is refused. The live files on 15 Nov 2026 were under 3 MB. */
export const LIST_BYTE_CAP = 12_000_000;

const REDIRECT = new Set([301, 302, 303, 307, 308]);

export function pinnedRedirect(currentUrl: string, location: string | null): string {
  if (!location) throw new Error("redirect had no location");
  const next = new URL(location, currentUrl);
  if (next.protocol !== "https:") throw new Error("redirect was not https");
  if (!OFFICIAL_HTTPS_HOSTS.has(next.hostname)) throw new Error("redirect left the official host");
  return next.toString();
}

export async function fetchOfficial(
  url: string,
  doFetch: typeof fetch = fetch,
): Promise<{ ok: boolean; status: number; body: string }> {
  let current = url;
  for (let hop = 0; hop < 4; hop += 1) {
    const response = await doFetch(current, {
      redirect: "manual",
      signal: AbortSignal.timeout(45_000),
      headers: { "user-agent": "CurrencyDesk-list-fetch" },
    });
    if (REDIRECT.has(response.status)) {
      current = pinnedRedirect(current, response.headers.get("location"));
      continue;
    }
    const body = await response.text();
    if (body.length > LIST_BYTE_CAP) throw new Error("list exceeded the byte cap");
    return { ok: response.ok, status: response.status, body };
  }
  throw new Error("too many redirects");
}

/** More than 10 percent fewer rows than the last good snapshot. */
export function listShrank(previousCount: number, nextCount: number): boolean {
  if (previousCount <= 0) return false;
  return nextCount * 10 < previousCount * 9;
}

export async function fetchOne(db: SqlDb, source: ListSource, get: FetchBody): Promise<"good" | "unchanged" | "failed"> {
  const previous = await latestGood(db, source.key);
  let downloaded: { ok: boolean; status: number; body: string };
  try {
    downloaded = await get(source.url);
  } catch (err) {
    await storeFailed(db, source, err instanceof Error ? err.message : "fetch failed", previous);
    return "failed";
  }
  if (!downloaded.ok) {
    await storeFailed(db, source, `HTTP ${downloaded.status}`, previous);
    return "failed";
  }
  if (downloaded.body.length > LIST_BYTE_CAP) {
    await storeFailed(db, source, "list exceeded the byte cap", previous);
    return "failed";
  }
  let entries: ListEntry[];
  try {
    entries = source.parse(downloaded.body);
  } catch (err) {
    await storeFailed(db, source, err instanceof Error ? err.message : "parse failed", previous);
    return "failed";
  }
  if (!entries.length) {
    await storeFailed(db, source, "parsed list was empty", previous);
    return "failed";
  }
  if (previous && listShrank(previous.keys.length, entries.length)) {
    await storeFailed(db, source, "list shrank by more than 10 percent", previous);
    return "failed";
  }
  const hash = sha256(downloaded.body);
  if (previous && previous.hash === hash) {
    await markUnchanged(db, previous.snapshotId, source.key);
    return "unchanged";
  }
  let stored: { added: number; removed: number };
  try {
    stored = await storeGood(db, source, downloaded.body, entries, previous);
  } catch (err) {
    await storeFailed(db, source, err instanceof Error ? err.message : "store failed", previous);
    return "failed";
  }
  if (stored.added > 0 || stored.removed > 0) {
    const pool = pgPool(db);
    if (pool) {
      try { await rescreenAll(pool); }
      catch (err) { console.error(`[sanctions] rescreen failed: ${err instanceof Error ? err.name : "Error"}`); }
    }
  }
  return "good";
}

export async function fetchAll(db: SqlDb, get: FetchBody = fetchOfficial, sources: readonly ListSource[] = LIST_SOURCES): Promise<void> {
  for (const source of sources) {
    try {
      await fetchOne(db, source, get);
    } catch (err) {
      console.error(`[sanctions] ${source.key} store failed: ${err instanceof Error ? err.name : "Error"}`);
    }
  }
}

export function startSanctionsFetch(db: SqlDb, get: FetchBody = fetchOfficial): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;
  const run = () => {
    void fetchAll(db, get).finally(() => {
      if (stopped) return;
      timer = setTimeout(run, DAY_MS);
    });
  };
  run();
  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
  };
}
