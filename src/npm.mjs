/** Map npm package names to GitHub repos through the public npm registry. */
import { getJson } from './http.mjs';
import { noCache } from './cache.mjs';

/** "git+https://github.com/o/r.git", "github:o/r", "o/r" -> "o/r", else null. */
export function githubRepoFromUrl(url) {
  if (!url) return null;
  const s = String(url).trim();
  const short = s.match(/^(?:github:)?([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+)$/);
  if (short) return `${short[1]}/${short[2].replace(/\.git$/, '')}`;
  const m = s.match(/github\.com[/:]([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+?)(?:\.git)?(?:[/#?].*)?$/i);
  return m ? `${m[1]}/${m[2]}` : null;
}

/** Dependencies of a package.json (object) -> [{ name, repo|null }]. */
export async function reposForPackage(pkg, { dev = false, fetchImpl = globalThis.fetch, cache = noCache } = {}) {
  const names = Object.keys({ ...(pkg.dependencies || {}), ...(dev ? pkg.devDependencies || {} : {}) });
  const out = [];
  for (const name of names) {
    const url = `https://registry.npmjs.org/${name}/latest`;
    let meta = cache.get(url);
    if (meta === undefined) {
      try {
        const full = await getJson('npm', url, { fetchImpl, retries: 1, headers: { Accept: 'application/json' } });
        meta = { repository: full.repository || null };
        cache.set(url, meta);
      } catch {
        meta = { repository: null };
      }
    }
    const r = meta.repository;
    out.push({ name, repo: githubRepoFromUrl(typeof r === 'string' ? r : r?.url) });
  }
  return out;
}
