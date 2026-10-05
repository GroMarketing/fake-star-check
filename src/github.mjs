/**
 * Read-only GitHub client. Only public data is requested.
 *
 * GitHub stopped serving stargazer lists (REST /stargazers answers 404 and the
 * GraphQL `stargazers` connection comes back empty), so the stargazer sample
 * comes from the repository's public event feed: WatchEvents carry the login
 * and the time of each star. That feed holds at most 300 events and 90 days.
 */
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import { getJson, registerSecret, ApiError } from './http.mjs';
import { noCache } from './cache.mjs';

const API = 'https://api.github.com';
const UA = 'fake-star-check (+https://github.com/GroMarketing/fake-star-check)';

/** GITHUB_TOKEN, then GH_TOKEN, then `gh auth token` if the gh CLI is logged in. */
export function resolveToken({ allowGhCli = true } = {}) {
  const t = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  if (t) return t;
  if (!allowGhCli) return null;
  try {
    const out = execFileSync('gh', ['auth', 'token'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000 }).trim();
    if (out) {
      registerSecret(out);
      return out;
    }
  } catch {
    // gh is not installed or not logged in.
  }
  return null;
}

export const isRepoName = (s) => /^[A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100}$/.test(s);

export function createGitHub({ token, fetchImpl = globalThis.fetch, cache = noCache, retryDelayMs } = {}) {
  if (!token) {
    throw new Error('No GitHub token. Set GITHUB_TOKEN (any token works, no scopes needed for public repos) or log in with `gh auth login`.');
  }
  registerSecret(token);
  // Cache keys are scoped to the token, so data one token can see is not served to another.
  const scope = crypto.createHash('sha256').update(`fake-star-check:${token}`).digest('hex').slice(0, 12);
  const rate = { remaining: null, reset: null, graphqlRemaining: null };
  const headers = (accept = 'application/vnd.github+json') => ({
    Authorization: `Bearer ${token}`,
    Accept: accept,
    'User-Agent': UA,
    'X-GitHub-Api-Version': '2022-11-28',
  });
  const track = (h, key) => {
    const r = h?.get?.('x-ratelimit-remaining');
    if (r != null) rate[key] = Number(r);
    const reset = h?.get?.('x-ratelimit-reset');
    if (reset != null) rate.reset = Number(reset);
  };

  async function rest(pathAndQuery, { accept } = {}) {
    const url = `${API}/${pathAndQuery}`;
    const key = `${scope} GET ${url} ${accept || ''}`;
    const hit = cache.get(key);
    if (hit !== undefined) return hit;
    try {
      const { data, headers: h } = await getJson('GitHub', url, { headers: headers(accept), fetchImpl, withMeta: true, retryDelayMs });
      track(h, 'remaining');
      cache.set(key, data);
      return data;
    } catch (e) {
      if (e instanceof ApiError && e.status === 403 && /rate limit/i.test(e.message)) {
        throw new ApiError('GitHub', 403, 'rate limit reached. Wait for the reset or use a different token.');
      }
      throw e;
    }
  }

  /** Returns { data, errors }. Partial results are returned (not cached) when some fields failed. */
  async function graphql(query, variables) {
    const body = JSON.stringify({ query, variables });
    const key = `${scope} POST graphql ${body}`;
    const hit = cache.get(key);
    if (hit !== undefined) return { data: hit, errors: [] };
    const { data, headers: h } = await getJson('GitHub', `${API}/graphql`, {
      method: 'POST',
      body,
      headers: { ...headers(), 'Content-Type': 'application/json' },
      fetchImpl,
      withMeta: true,
      retryDelayMs,
    });
    track(h, 'graphqlRemaining');
    const errors = data.errors || [];
    const fatal = errors.filter((e) => e.type !== 'NOT_FOUND');
    if (!data.data) throw new ApiError('GitHub', 'graphql', fatal.map((e) => e.message).join('; ') || 'empty response');
    // Missing users come back as null plus a NOT_FOUND error; that is data, not failure.
    // Anything else (timeouts, partial failures) must not be cached.
    if (!fatal.length) cache.set(key, data.data);
    return { data: data.data, errors };
  }

  async function userBatch(chunk) {
    const vars = Object.fromEntries(chunk.map((l, j) => [`l${j}`, l]));
    const query = `query(${chunk.map((_, j) => `$l${j}: String!`).join(', ')}) {
${chunk.map((_, j) => `  u${j}: user(login: $l${j}) { ...P }`).join('\n')}
}
fragment P on User {
  login createdAt updatedAt bio company websiteUrl
  followers { totalCount } following { totalCount }
  repositories(ownerAffiliations: OWNER) { totalCount }
  gists { totalCount } starredRepositories { totalCount } organizations { totalCount }
  contributionsCollection { contributionCalendar { totalContributions } }
}`;
    const { data, errors } = await graphql(query, vars);
    const notFound = new Set(errors.filter((e) => e.type === 'NOT_FOUND').map((e) => e.path?.[0]));
    const out = new Map();
    chunk.forEach((l, j) => {
      const u = data[`u${j}`];
      if (u) out.set(l, normalizeUser(u));
      else if (notFound.has(`u${j}`)) out.set(l, null);
      // else: the field failed; leave it unset so the caller can retry.
    });
    return out;
  }

  return {
    rate,
    repo: (full) => rest(`repos/${full}`),
    restUser: (login) => rest(`users/${encodeURIComponent(login)}`),

    /** Up to 300 most recent public events (GitHub's cap), newest first. */
    async events(full, { maxPages = 3 } = {}) {
      const all = [];
      for (let page = 1; page <= maxPages; page++) {
        let batch;
        try {
          batch = await rest(`repos/${full}/events?per_page=100&page=${page}`);
        } catch (e) {
          if (e instanceof ApiError && e.status === 422) break; // pagination cap
          throw e;
        }
        if (!Array.isArray(batch)) break;
        all.push(...batch);
        if (batch.length < 100) break;
      }
      return all;
    },

    /**
     * Profiles for many logins, batched through GraphQL aliases. A login maps to
     * a profile, to null when GraphQL says NOT_FOUND, or is absent when the
     * lookup failed twice (callers fall back to REST).
     */
    async users(logins, { batchSize = 25 } = {}) {
      const out = new Map();
      for (let i = 0; i < logins.length; i += batchSize) {
        for (const [k, v] of await userBatch(logins.slice(i, i + batchSize))) out.set(k, v);
      }
      const retry = logins.filter((l) => !out.has(l));
      for (let i = 0; i < retry.length; i += 5) {
        try {
          for (const [k, v] of await userBatch(retry.slice(i, i + 5))) out.set(k, v);
        } catch {
          // Leave them absent.
        }
      }
      return out;
    },

    /** A user's most recent stars with timestamps (one page, newest first). */
    async starred(login, { perPage = 100 } = {}) {
      const rows = await rest(`users/${encodeURIComponent(login)}/starred?per_page=${perPage}`, { accept: 'application/vnd.github.star+json' });
      return (Array.isArray(rows) ? rows : []).map((r) => ({ repo: r.repo?.full_name, at: r.starred_at, stars: r.repo?.stargazers_count }));
    },

    /** Repos with a similar star count (and language, when known) for ratio baselines. */
    async peers(repo) {
      const s = repo.stargazers_count;
      const lo = Math.max(1, Math.floor(s * 0.7));
      const hi = Math.ceil(s * 1.3);
      const q = [`stars:${lo}..${hi}`, 'fork:false', 'archived:false', repo.language ? `language:"${repo.language}"` : ''].filter(Boolean).join(' ');
      const res = await rest(`search/repositories?q=${encodeURIComponent(q)}&per_page=100`);
      return (res.items || []).filter((r) => r.full_name !== repo.full_name).map((r) => ({ stars: r.stargazers_count, forks: r.forks_count, openIssues: r.open_issues_count }));
    },
  };
}

function normalizeUser(u) {
  if (!u) return null;
  return {
    login: u.login,
    createdAt: u.createdAt,
    updatedAt: u.updatedAt,
    bio: u.bio || '',
    company: u.company || '',
    website: u.websiteUrl || '',
    followers: u.followers?.totalCount ?? 0,
    following: u.following?.totalCount ?? 0,
    repos: u.repositories?.totalCount ?? 0,
    gists: u.gists?.totalCount ?? 0,
    starred: u.starredRepositories?.totalCount ?? 0,
    orgs: u.organizations?.totalCount ?? 0,
    contributions: u.contributionsCollection?.contributionCalendar?.totalContributions ?? 0,
  };
}
