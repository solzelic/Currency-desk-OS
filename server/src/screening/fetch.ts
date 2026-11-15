import type { ListEntry } from "./match.js";
import type { ListSource } from "./sources.js";
import { LIST_SOURCES } from "./sources.js";
import { latestGood, markUnchanged, sha256, storeFailed, storeGood, type SqlDb } from "./store.js";

export type FetchBody = (url: string) => Promise<{ ok: boolean; status: number; body: string }>;

const DAY_MS = 24 * 60 * 60 * 1000;

export async function fetchOfficial(url: string): Promise<{ ok: boolean; status: number; body: string }> {
  const response = await fetch(url, {
    redirect: "follow",
    signal: AbortSignal.timeout(45_000),
    headers: { "user-agent": "CurrencyDesk-list-fetch" },
  });
  const body = await response.text();
  return { ok: response.ok, status: response.status, body };
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
  const hash = sha256(downloaded.body);
  if (previous && previous.hash === hash) {
    await markUnchanged(db, previous.snapshotId, source.key);
    return "unchanged";
  }
  await storeGood(db, source, downloaded.body, entries, previous);
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
