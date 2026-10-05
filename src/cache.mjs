/**
 * A small file cache for public API responses, so re-running a check (or
 * checking ten repos that share stargazers) does not spend the rate limit
 * twice. Keys are hashes of the request (URL, or URL + GraphQL body). GitHub
 * keys also include a short hash of the token, so a response fetched with one
 * token is never served to another. The token itself is never written to disk.
 * Files are 0600 in a 0700 directory.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

export function defaultCacheDir() {
  const base = process.env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache');
  return path.join(base, 'fake-star-check');
}

/** A cache that does nothing. Used for --no-cache and in tests. */
export const noCache = { get: () => undefined, set: () => {} };

/** In-memory cache, mostly for tests and the MCP server. */
export function memoryCache() {
  const m = new Map();
  return { get: (k) => m.get(k), set: (k, v) => m.set(k, v) };
}

export function fileCache({ dir = defaultCacheDir(), ttlMs = 6 * 3600 * 1000 } = {}) {
  const file = (key) => path.join(dir, crypto.createHash('sha256').update(key).digest('hex').slice(0, 32) + '.json');
  return {
    get(key) {
      try {
        const f = file(key);
        const st = fs.statSync(f);
        if (Date.now() - st.mtimeMs > ttlMs) return undefined;
        return JSON.parse(fs.readFileSync(f, 'utf8'));
      } catch {
        return undefined;
      }
    },
    set(key, value) {
      try {
        fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
        fs.writeFileSync(file(key), JSON.stringify(value), { mode: 0o600 });
      } catch {
        // A cache that cannot write is just a slower run.
      }
    },
  };
}
