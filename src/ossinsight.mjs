/**
 * Star history from OSS Insight (https://ossinsight.io), a free public API
 * built on the GH Archive event stream. No key is needed; it is rate limited
 * (about 600 requests an hour per IP). A check makes one call per 2,000 days of
 * history plus two for issue and PR authors.
 *
 * Its counts are derived from WatchEvents, so they are a lower bound and can
 * differ from the star count GitHub shows today (unstars and deleted accounts
 * are not subtracted the same way).
 */
import { getJson } from './http.mjs';
import { noCache } from './cache.mjs';

const BASE = 'https://api.ossinsight.io/v1/repos';

const PAGE = 2000;

export function createOssInsight({ fetchImpl = globalThis.fetch, cache = noCache, retryDelayMs, maxPages = 8 } = {}) {
  async function page(full, metric, per, from) {
    const url = `${BASE}/${full}/${metric}/history?per=${per}${from ? `&from=${from}` : ''}`;
    const hit = cache.get(`v2 ${url}`);
    if (hit?.rows) return hit;
    const res = await getJson('OSS Insight', url, { fetchImpl, retries: 2, retryDelayMs, headers: { Accept: 'application/json' } });
    const rows = (res?.data?.rows || []).map((r) => ({ date: r.date, total: Number(r[metric]) })).filter((r) => r.date && Number.isFinite(r.total));
    const out = { rows, quality: res?.data_quality || null };
    cache.set(`v2 ${url}`, out);
    return out;
  }

  // The API returns at most PAGE rows per call; later pages are requested
  // with `from`, and totals stay cumulative from the repo's first star.
  async function series(full, metric, per) {
    const all = [];
    let from = null;
    for (let i = 0; i < maxPages; i++) {
      const { rows, quality } = await page(full, metric, per, from);
      all.push(...rows);
      if (quality) all.quality = quality;
      if (rows.length < PAGE) break;
      const next = new Date(rows.at(-1).date.slice(0, 10) + 'T00:00:00Z');
      next.setUTCDate(next.getUTCDate() + 1);
      from = next.toISOString().slice(0, 10);
    }
    return all;
  }

  return {
    /**
     * Cumulative stars per day, oldest first. Days with no new stars are absent.
     * The array carries `.quality`: OSS Insight's own data-quality note, if any.
     */
    starsDaily: (full) => series(full, 'stargazers', 'day'),
    issueCreatorsMonthly: (full) => series(full, 'issue_creators', 'month'),
    prCreatorsMonthly: (full) => series(full, 'pull_request_creators', 'month'),
  };
}

/** Cumulative rows (sparse days) to a dense list of { date, n } new per day. */
export function dailyDeltas(rows) {
  if (!rows.length) return [];
  const sorted = [...rows].sort((a, b) => a.date.localeCompare(b.date));
  const byDay = new Map(sorted.map((r) => [r.date.slice(0, 10), r.total]));
  const out = [];
  const day = new Date(sorted[0].date.slice(0, 10) + 'T00:00:00Z');
  const end = new Date(sorted.at(-1).date.slice(0, 10) + 'T00:00:00Z');
  let prev = 0;
  while (day <= end) {
    const k = day.toISOString().slice(0, 10);
    const total = byDay.has(k) ? byDay.get(k) : prev;
    out.push({ date: k, n: Math.max(0, total - prev) });
    prev = Math.max(prev, total);
    day.setUTCDate(day.getUTCDate() + 1);
  }
  return out;
}

/** Cumulative monthly rows to a Map of 'YYYY-MM' -> new that month. */
export function monthlyDeltas(rows) {
  const sorted = [...rows].sort((a, b) => a.date.localeCompare(b.date));
  const out = new Map();
  let prev = 0;
  for (const r of sorted) {
    out.set(r.date.slice(0, 7), Math.max(0, r.total - prev));
    prev = Math.max(prev, r.total);
  }
  return out;
}
