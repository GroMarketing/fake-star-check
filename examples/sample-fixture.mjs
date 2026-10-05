// Synthetic data for the README samples and the tests. Every repo, account and
// number here is made up ("nonexistent-labs" is not a real GitHub owner). The
// mock fetch answers the same URLs the real clients call, so the samples go
// through the real checks and the real formatter.

const DAY = 86400000;

/** Small seeded PRNG so the fixture is the same on every run. */
function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

const iso = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');

/**
 * scenario: 'suspicious' (throwaway accounts in lockstep plus a burst) or
 * 'quiet' (ordinary accounts and steady growth).
 */
export function buildFixture(scenario = 'suspicious', { now = Date.parse('2026-09-30T12:00:00Z') } = {}) {
  const rand = rng(scenario === 'suspicious' ? 7 : 11);
  const sus = scenario === 'suspicious';
  const full = sus ? 'nonexistent-labs/widget-kit' : 'nonexistent-labs/tidy-logger';
  const created = Date.parse(sus ? '2026-03-02T00:00:00Z' : '2023-05-10T00:00:00Z');

  // Daily new stars, oldest first.
  const days = Math.round((now - created) / DAY);
  const daily = [];
  for (let i = 0; i <= days; i++) {
    let n = Math.round((sus ? 4 : 9) + rand() * 4);
    if (sus && i === days - 25) n = 1840;
    if (sus && i === days - 24) n = 1260;
    daily.push(n);
  }
  const starEvents = daily.reduce((a, b) => a + b, 0);
  const stars = sus ? starEvents - 610 : starEvents - 140;

  // Accounts that starred recently, newest first.
  const users = new Map();
  const starredLists = new Map();
  const events = [];
  const throwawayShare = sus ? 0.44 : 0.03;
  const cover = ['bigco/frontend-framework', 'bigco/runtime', 'popular/editor', 'popular/cli-tools', 'famous/db', 'famous/terminal', 'famous/lang'];
  const coverStars = { 'bigco/frontend-framework': 210000, 'bigco/runtime': 98000, 'popular/editor': 160000, 'popular/cli-tools': 41000, 'famous/db': 67000, 'famous/terminal': 88000, 'famous/lang': 120000 };
  const feedDays = sus ? 9 : 40;
  const watchCount = sus ? 240 : 150;
  let t = now;
  for (let i = 0; i < watchCount; i++) {
    t -= (feedDays * DAY) / watchCount;
    const login = `${sus ? 'w' : 't'}user-${String(i).padStart(3, '0')}`;
    const fake = rand() < throwawayShare;
    if (fake) {
      const born = t - Math.floor(rand() * 4) * DAY;
      users.set(login, { login, createdAt: iso(born), updatedAt: iso(born), bio: null, company: null, websiteUrl: '', followers: { totalCount: rand() < 0.7 ? 0 : 1 }, following: { totalCount: Math.floor(rand() * 2) }, repositories: { totalCount: rand() < 0.8 ? 0 : 1 }, gists: { totalCount: 0 }, starredRepositories: { totalCount: 9 }, organizations: { totalCount: 0 }, contributionsCollection: { contributionCalendar: { totalContributions: 0 } } });
      starredLists.set(login, [{ repo: full, at: t }, ...cover.map((r, k) => ({ repo: r, at: t - (k + 1) * 3600000 }))]);
    } else if (sus && i % 41 === 3) {
      users.set(login, null); // deleted after starring
    } else {
      const born = t - (400 + Math.floor(rand() * 3000)) * DAY;
      users.set(login, { login, createdAt: iso(born), updatedAt: iso(t - 20 * DAY), bio: rand() < 0.5 ? 'builds things' : null, company: null, websiteUrl: '', followers: { totalCount: Math.floor(rand() * 60) }, following: { totalCount: Math.floor(rand() * 40) }, repositories: { totalCount: 3 + Math.floor(rand() * 50) }, gists: { totalCount: Math.floor(rand() * 3) }, starredRepositories: { totalCount: 50 + Math.floor(rand() * 400) }, organizations: { totalCount: Math.floor(rand() * 2) }, contributionsCollection: { contributionCalendar: { totalContributions: Math.floor(rand() * 900) } } });
      const own = Array.from({ length: 12 }, (_, k) => ({ repo: `person${i}/project-${k}`, at: t - k * 9 * DAY }));
      starredLists.set(login, [{ repo: full, at: t }, ...own]);
    }
    events.push({ type: 'WatchEvent', actor: { login }, created_at: iso(t), payload: { action: 'started' } });
    if (!sus && i % 5 === 0) events.push({ type: 'ForkEvent', actor: { login: `forker-${i}` }, created_at: iso(t), payload: {} });
    if (!sus && i % 9 === 0) events.push({ type: 'IssuesEvent', actor: { login: `filer-${i}` }, created_at: iso(t), payload: { action: 'opened' } });
    if (!sus && i % 11 === 0) events.push({ type: 'PullRequestEvent', actor: { login: `contrib-${i}` }, created_at: iso(t), payload: { action: 'opened' } });
    if (i % 20 === 0) events.push({ type: 'PushEvent', actor: { login: 'maintainer' }, created_at: iso(t), payload: {} });
  }
  if (sus) events.splice(30, 0, ...[0, 1, 2].map((k) => ({ type: 'ForkEvent', actor: { login: `forker-${k}` }, created_at: events[30].created_at, payload: {} })));
  const feed = events.slice(0, 300);

  const repo = {
    full_name: full,
    stargazers_count: stars,
    forks_count: sus ? 61 : Math.round(stars * 0.09),
    subscribers_count: sus ? 9 : 48,
    open_issues_count: sus ? 2 : 37,
    language: 'TypeScript',
    created_at: iso(created),
  };
  const peers = Array.from({ length: 100 }, (_, i) => {
    const s = Math.round(stars * (0.75 + rand() * 0.5));
    return { full_name: `peer-org/peer-${i}`, stargazers_count: s, forks_count: Math.round(s * (0.04 + rand() * 0.12)), open_issues_count: Math.floor(rand() * 80) };
  });

  // OSS Insight: cumulative series.
  const starRows = [];
  let cum = 0;
  daily.forEach((n, i) => {
    cum += n;
    starRows.push({ date: iso(created + i * DAY).slice(0, 10), stargazers: String(cum) });
  });
  const monthly = (perMonth) => {
    const rows = [];
    let c = 0;
    const d = new Date(created);
    while (d.getTime() <= now) {
      c += perMonth;
      rows.push({ date: d.toISOString().slice(0, 7) + '-01', v: String(c) });
      d.setUTCMonth(d.getUTCMonth() + 1);
    }
    return rows;
  };

  return { full, repo, feed, users, starredLists, coverStars, peers, starRows, issueRows: monthly(sus ? 1 : 6), prRows: monthly(sus ? 1 : 4), now };
}

/** A fetch() that serves the fixture. `calls` records every URL and init. */
export function fixtureFetch(fx) {
  const calls = [];
  const res = (body, status = 200) => ({
    ok: status < 400,
    status,
    headers: new Headers({ 'x-ratelimit-remaining': '4900', 'x-ratelimit-reset': '1790000000' }),
    text: async () => JSON.stringify(body),
  });
  const fn = async (url, init = {}) => {
    const u = new URL(String(url));
    calls.push({ url: String(url), init });
    if (u.hostname === 'api.ossinsight.io') {
      if (u.pathname.includes('/stargazers/history')) return res({ data: { rows: u.searchParams.get('from') ? [] : fx.starRows } });
      const rows = u.pathname.includes('issue_creators') ? fx.issueRows.map((r) => ({ date: r.date, issue_creators: r.v })) : fx.prRows.map((r) => ({ date: r.date, pull_request_creators: r.v }));
      return res({ data: { rows } });
    }
    const p = u.pathname;
    if (p === '/graphql') {
      const { variables } = JSON.parse(init.body);
      const data = {};
      const errors = [];
      for (const [k, login] of Object.entries(variables)) {
        const user = fx.users.get(login);
        data[`u${k.slice(1)}`] = user || null;
        if (!user) errors.push({ type: 'NOT_FOUND', path: [`u${k.slice(1)}`], message: 'Could not resolve to a User' });
      }
      return res({ data, errors: errors.length ? errors : undefined });
    }
    if (p === `/repos/${fx.full}`) return res(fx.repo);
    if (p === `/repos/${fx.full}/events`) {
      const page = Number(u.searchParams.get('page') || 1);
      if (page > 3) return res({ message: 'pagination is limited' }, 422);
      return res(fx.feed.slice((page - 1) * 100, page * 100));
    }
    if (p === '/search/repositories') return res({ items: fx.peers });
    let m = p.match(/^\/users\/([^/]+)\/starred$/);
    if (m) {
      const list = fx.starredLists.get(decodeURIComponent(m[1]));
      if (!list) return res({ message: 'Not Found' }, 404);
      return res(list.map((s) => ({ starred_at: new Date(s.at).toISOString(), repo: { full_name: s.repo, stargazers_count: s.repo === fx.full ? fx.repo.stargazers_count : fx.coverStars[s.repo] ?? 12 } })));
    }
    m = p.match(/^\/users\/([^/]+)$/);
    if (m) return res({ message: 'Not Found' }, 404);
    return res({ message: `fixture has no route for ${p}` }, 404);
  };
  fn.calls = calls;
  return fn;
}
