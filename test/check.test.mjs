// Offline tests: every response is synthetic. No credentials, no network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  checkRepo, createGitHub, createOssInsight, dailyDeltas, monthlyDeltas, profileCheck, lockstepCheck, burstCheck, removalCheck,
  ratioCheck, activityCheck, assess, sampleStars, text, markdown, githubRepoFromUrl, reposForPackage, memoryCache, redact,
} from '../src/index.mjs';
import { registerSecret } from '../src/http.mjs';
import { buildFixture, fixtureFetch } from '../examples/sample-fixture.mjs';

const TOKEN = 'ghp_' + 'T'.repeat(36);
const BIN = fileURLToPath(new URL('../bin/fake-star-check.mjs', import.meta.url));
const DAY = 86400000;

const run = (scenario, extra = {}) => {
  const fx = buildFixture(scenario);
  const fetchImpl = fixtureFetch(fx);
  return checkRepo(fx.full, { token: TOKEN, fetchImpl, now: new Date(fx.now), retryDelayMs: 0, ...extra }).then((report) => ({ report, fetchImpl, fx }));
};

const res = (body, status = 200, headers = {}) => ({ ok: status < 400, status, headers: new Headers(headers), text: async () => (typeof body === 'string' ? body : JSON.stringify(body)) });

test('suspicious fixture: strong signals, with evidence and caveats', async () => {
  const { report } = await run('suspicious');
  assert.equal(report.assessment.level, 'strong');
  const by = Object.fromEntries(report.checks.map((c) => [c.id, c]));
  assert.equal(by.profiles.level, 'strong');
  assert.equal(by.lockstep.level, 'strong');
  assert.equal(by.lockstep.data.pattern, 'odd-one-out');
  assert.equal(by.bursts.level, 'moderate');
  assert.match(by.bursts.evidence.join(' '), /consistent with a launch/);
  assert.match(by.profiles.evidence[0], /^\d+% of 60 sampled recent stargazers/);
  assert.equal(report.method.sample.used, 60);
  assert.ok(report.caveats[0].includes('not proof'));
  const out = text(report);
  assert.match(out, /Assessment: STRONG SIGNALS/);
  assert.match(out, /not proof/);
  assert.match(out, /Sample: 60 of the 240 stars/);
});

test('quiet fixture: no notable signals', async () => {
  const { report } = await run('quiet');
  assert.equal(report.assessment.level, 'none');
  assert.ok(report.checks.every((c) => c.level === 'none' || c.level === 'n/a'), JSON.stringify(report.checks.map((c) => [c.id, c.level])));
});

test('the token goes in GitHub headers only: never in a URL, never to OSS Insight, never in output', async () => {
  const { report, fetchImpl } = await run('suspicious');
  assert.ok(fetchImpl.calls.length > 10);
  for (const c of fetchImpl.calls) {
    assert.ok(!c.url.includes(TOKEN), `token in URL ${c.url}`);
    const auth = c.init.headers?.Authorization;
    if (c.url.startsWith('https://api.github.com/')) assert.equal(auth, `Bearer ${TOKEN}`);
    else assert.equal(auth, undefined, `credential sent to ${c.url}`);
  }
  assert.ok(!JSON.stringify(report).includes(TOKEN));
  assert.ok(!text(report).includes(TOKEN));
});

test('requests do not scale with star count (sampled, capped event pages)', async () => {
  const { fetchImpl } = await run('suspicious');
  const events = fetchImpl.calls.filter((c) => c.url.includes('/events'));
  assert.ok(events.length <= 3);
  const starred = fetchImpl.calls.filter((c) => c.url.includes('/starred'));
  assert.ok(starred.length <= 60);
  const { fetchImpl: f2 } = await run('suspicious', { sample: 20, lockstep: false, peers: false, history: false });
  assert.equal(f2.calls.filter((c) => c.url.includes('/starred')).length, 0);
  assert.equal(f2.calls.filter((c) => c.url.includes('ossinsight')).length, 0);
});

test('lockstep is skipped when the rate limit is nearly spent', async () => {
  const fx = buildFixture('suspicious');
  const base = fixtureFetch(fx);
  const low = async (url, init) => {
    const r = await base(url, init);
    return { ...r, headers: new Headers({ 'x-ratelimit-remaining': '12' }) };
  };
  const report = await checkRepo(fx.full, { token: TOKEN, fetchImpl: low, retryDelayMs: 0 });
  const lock = report.checks.find((c) => c.id === 'lockstep');
  assert.equal(lock.level, 'n/a');
  assert.match(report.notes.join(' '), /rate limit|requests left/);
});

test('profileCheck: too few stargazers is n/a, not a verdict', () => {
  const sample = [{ login: 'a', at: '2026-01-01T00:00:00Z' }];
  const c = profileCheck({ sample, users: new Map([['a', { createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z', followers: 0, following: 0, repos: 0, gists: 0 }]]) });
  assert.equal(c.level, 'n/a');
});

const throwaways = (n, fakeShare, at = '2026-09-01T00:00:00Z') => {
  const sample = [];
  const users = new Map();
  for (let i = 0; i < n; i++) {
    const fake = i < n * fakeShare;
    sample.push({ login: `u${i}`, at });
    users.set(`u${i}`, fake
      ? { createdAt: '2026-08-30T00:00:00Z', updatedAt: '2026-08-30T00:00:00Z', followers: 0, following: 0, repos: 0, gists: 0, bio: '' }
      : { createdAt: '2019-01-01T00:00:00Z', updatedAt: '2026-08-01T00:00:00Z', followers: 30, following: 10, repos: 20, gists: 1, bio: 'x' });
  }
  return { sample, users };
};

test('profileCheck: levels follow the flagged share', () => {
  assert.equal(profileCheck(throwaways(50, 0.5)).level, 'strong');
  assert.equal(profileCheck(throwaways(50, 0.24)).level, 'moderate');
  assert.equal(profileCheck(throwaways(50, 0.12)).level, 'weak');
  assert.equal(profileCheck(throwaways(50, 0.02)).level, 'none');
});

test('profileCheck: on a big repo with a thin feed, throwaway stargazers are capped at weak', () => {
  const c = profileCheck({ ...throwaways(50, 0.6), starCount: 80000, coverage: { days: 3, stars: 50, shareOfStars: 50 / 80000 } });
  assert.equal(c.level, 'weak');
  assert.match(c.evidence.join(' '), /popular repos to look normal/);
});

test('profileCheck: deleted accounts count as flagged, restricted ones are only reported', () => {
  const { sample, users } = throwaways(20, 0);
  const deleted = new Set(['u0', 'u1', 'u2']);
  const restricted = new Set(['u3', 'u4', 'u5', 'u6', 'u7']);
  for (const l of deleted) users.delete(l);
  const c = profileCheck({ sample, users, deleted, restricted });
  assert.equal(c.data.deleted, 3);
  assert.equal(c.data.restricted, 5);
  assert.equal(c.data.flaggedShare, 0.15);
  assert.equal(c.level, 'weak');
});

const lists = (groups) => {
  const m = new Map();
  for (const { prefix, count, repos, stars, base } of groups) {
    for (let i = 0; i < count; i++) m.set(`${prefix}${i}`, repos.map((r, k) => ({ repo: r, at: new Date(base + i * 3600000 + k * 60000).toISOString(), stars: stars[r] })));
  }
  return m;
};

test('lockstepCheck: a small repo hidden among big ones is called out; a big repo in the same company is capped', () => {
  const big = ['big/a', 'big/b', 'big/c', 'big/d', 'big/e', 'big/f'];
  const stars = Object.fromEntries(big.map((r) => [r, 90000]));
  const coordinated = { prefix: 'f', count: 8, repos: big, stars, base: Date.parse('2026-09-01T00:00:00Z') };
  const m = lists([coordinated]);
  for (let i = 0; i < 12; i++) m.set(`o${i}`, Array.from({ length: 8 }, (_, k) => ({ repo: `p${i}/r${k}`, at: new Date(Date.parse('2026-01-01') + k * 40 * DAY).toISOString(), stars: 10 })));
  const small = lockstepCheck({ lists: m, target: 'x/small', starCount: 900 });
  assert.equal(small.data.inLockstep, 8);
  assert.equal(small.level, 'strong');
  assert.equal(small.data.pattern, 'odd-one-out');
  const popular = lockstepCheck({ lists: m, target: 'x/popular', starCount: 120000 });
  assert.equal(popular.level, 'weak');
  assert.equal(popular.data.pattern, 'cover');
});

test('lockstepCheck: shared repos starred far apart in time are not lockstep', () => {
  const repos = ['r/1', 'r/2', 'r/3', 'r/4', 'r/5', 'r/6'];
  const m = new Map();
  for (let i = 0; i < 12; i++) m.set(`u${i}`, repos.map((r) => ({ repo: r, at: new Date(Date.parse('2020-01-01') + i * 60 * DAY).toISOString(), stars: 500 })));
  assert.equal(lockstepCheck({ lists: m, target: 'x/y', starCount: 100 }).data.inLockstep, 0);
});

const flatDaily = (days, n, start = '2024-01-01') => Array.from({ length: days }, (_, i) => ({ date: new Date(Date.parse(start) + i * DAY).toISOString().slice(0, 10), n }));

test('burstCheck: a burst with no matching issue/PR activity is moderate and framed as launch-or-purchase', () => {
  const daily = flatDaily(200, 5);
  daily[150].n = 1800;
  daily[151].n = 1300;
  const issues = new Map([...new Set(daily.map((d) => d.date.slice(0, 7)))].map((m) => [m, 1]));
  const c = burstCheck({ daily, issueMonthly: issues, prMonthly: issues });
  assert.equal(c.level, 'moderate');
  assert.match(c.evidence.join(' '), /3,100 stars in 2 days/);
  assert.match(c.evidence.join(' '), /consistent with a launch \(for example a Hacker News front page\) or with purchased stars/);
});

test('burstCheck: a burst that brings issue and PR authors is only weak', () => {
  const daily = flatDaily(200, 5);
  daily[150].n = 1800;
  const month = daily[150].date.slice(0, 7);
  const months = [...new Set(daily.map((d) => d.date.slice(0, 7)))];
  const issues = new Map(months.map((m) => [m, m === month ? 40 : 2]));
  const c = burstCheck({ daily, issueMonthly: issues, prMonthly: new Map() });
  assert.equal(c.level, 'weak');
  assert.match(c.evidence.join(' '), /what a real launch looks like/);
});

test('burstCheck: steady growth has no bursts; degraded data periods are disclosed', () => {
  const c = burstCheck({ daily: flatDaily(400, 7, '2025-01-01'), quality: { suspect_since: '2025-05-23', severely_degraded_since: '2026-05-01' } });
  assert.equal(c.level, 'none');
  assert.match(c.evidence.join(' '), /lower bounds from 2025-05-23/);
});

test('removalCheck: large losses are flagged, normal churn is not', () => {
  assert.equal(removalCheck({ starEvents: 2400, githubStars: 180 }).level, 'moderate');
  assert.equal(removalCheck({ starEvents: 1000, githubStars: 700 }).level, 'weak');
  assert.equal(removalCheck({ starEvents: 1000, githubStars: 960 }).level, 'none');
  assert.equal(removalCheck({ starEvents: 0, githubStars: 10 }).level, 'n/a');
});

test('ratioCheck and activityCheck', () => {
  const peers = Array.from({ length: 50 }, (_, i) => ({ stars: 1000, forks: 60 + i }));
  assert.equal(ratioCheck({ repo: { stargazers_count: 1000, forks_count: 5, open_issues_count: 0 }, peers }).level, 'weak');
  assert.equal(ratioCheck({ repo: { stargazers_count: 1000, forks_count: 80, open_issues_count: 0 }, peers }).level, 'none');
  assert.equal(ratioCheck({ repo: { stargazers_count: 1000, forks_count: 80, open_issues_count: 0 }, peers: [] }).level, 'n/a');
  const ev = (type, n, action) => Array.from({ length: n }, (_, i) => ({ type, created_at: new Date(Date.parse('2026-09-01') + i * 3600000).toISOString(), payload: action ? { action } : {} }));
  assert.equal(activityCheck({ events: ev('WatchEvent', 80) }).level, 'weak');
  assert.equal(activityCheck({ events: [...ev('WatchEvent', 80), ...ev('ForkEvent', 4)] }).level, 'none');
  assert.equal(activityCheck({ events: ev('WatchEvent', 10) }).level, 'n/a');
});

test('assess: bursts alone never reach strong, and clean account checks soften them', () => {
  const c = (id, level, data = {}) => ({ id, level, evidence: [], data });
  const burstOnly = assess([c('profiles', 'n/a'), c('bursts', 'moderate'), c('ratios', 'weak'), c('removed', 'moderate')]);
  assert.notEqual(burstOnly.level, 'strong');
  assert.match(burstOnly.summary, /consistent with a launch/);
  const clean = assess([c('profiles', 'none', { sampled: 60 }), c('lockstep', 'none'), c('bursts', 'moderate')]);
  assert.equal(clean.level, 'weak');
  assert.match(clean.summary, /ordinary accounts/);
  assert.equal(assess([c('profiles', 'strong'), c('lockstep', 'moderate')]).level, 'strong');
  assert.equal(assess([c('profiles', 'none', { sampled: 60 }), c('lockstep', 'none')]).level, 'none');
});

test('sampleStars: one entry per login, spread across the feed', () => {
  const events = Array.from({ length: 200 }, (_, i) => ({ type: 'WatchEvent', actor: { login: `u${i % 150}` }, created_at: '2026-09-01T00:00:00Z' }));
  const { all, sample } = sampleStars(events, 50);
  assert.equal(all.length, 150);
  assert.equal(sample.length, 50);
  assert.equal(new Set(sample.map((s) => s.login)).size, 50);
  assert.equal(sample[0].login, 'u0');
  assert.equal(sample.at(-1).login, 'u147');
});

test('dailyDeltas fills missing days; monthlyDeltas differences cumulative rows', () => {
  const d = dailyDeltas([{ date: '2026-01-01', total: 10 }, { date: '2026-01-04', total: 16 }]);
  assert.deepEqual(d.map((x) => x.n), [10, 0, 0, 6]);
  const m = monthlyDeltas([{ date: '2026-01-01', total: 3 }, { date: '2026-02-01', total: 10 }]);
  assert.equal(m.get('2026-02'), 7);
});

test('OSS Insight: pages past 2,000 rows with `from`, and passes its data-quality note through', async () => {
  const urls = [];
  const rows = (start, n, base) => Array.from({ length: n }, (_, i) => ({ date: new Date(Date.parse(start) + i * DAY).toISOString().slice(0, 10), stargazers: String(base + i) }));
  const fetchImpl = async (url) => {
    urls.push(String(url));
    const from = new URL(String(url)).searchParams.get('from');
    return res({ data: { rows: from ? rows(from, 5, 2000) : rows('2020-01-01', 2000, 0) }, data_quality: { suspect_since: '2025-05-23' } });
  };
  const s = await createOssInsight({ fetchImpl }).starsDaily('a/b');
  assert.equal(s.length, 2005);
  assert.equal(urls.length, 2);
  assert.match(urls[1], /from=2025-06-23/);
  assert.equal(s.quality.suspect_since, '2025-05-23');
});

test('GitHub client: GraphQL partial failures are retried and never cached; NOT_FOUND maps to null', async () => {
  let graphqlCalls = 0;
  const fetchImpl = async (url, init) => {
    graphqlCalls++;
    const { variables } = JSON.parse(init.body);
    const data = {};
    const errors = [];
    Object.entries(variables).forEach(([k, login]) => {
      const alias = `u${k.slice(1)}`;
      if (login === 'gone') { data[alias] = null; errors.push({ type: 'NOT_FOUND', path: [alias] }); }
      else if (login === 'flaky' && graphqlCalls === 1) { data[alias] = null; errors.push({ type: 'SERVICE_UNAVAILABLE', path: [alias] }); }
      else data[alias] = { login, createdAt: '2020-01-01T00:00:00Z', updatedAt: '2020-01-01T00:00:00Z', followers: { totalCount: 3 } };
    });
    return res({ data, errors });
  };
  const cache = memoryCache();
  const gh = createGitHub({ token: TOKEN, fetchImpl, cache, retryDelayMs: 0 });
  const users = await gh.users(['ok', 'gone', 'flaky']);
  assert.equal(users.get('ok').followers, 3);
  assert.equal(users.get('gone'), null);
  assert.equal(users.get('flaky').login, 'flaky');
  assert.equal(graphqlCalls, 2);
  // The first (partial) response was not cached, so asking again goes back to the API.
  await gh.users(['ok', 'gone', 'flaky']);
  assert.equal(graphqlCalls, 3);
});

test('GitHub client: event pagination stops at the 422 cap; missing token is a clear error', async () => {
  let pages = 0;
  const fetchImpl = async (url) => {
    pages++;
    const page = Number(new URL(String(url)).searchParams.get('page'));
    return page >= 2 ? res({ message: 'In order to keep the API fast for everyone, pagination is limited' }, 422) : res(Array.from({ length: 100 }, () => ({ type: 'WatchEvent' })));
  };
  const gh = createGitHub({ token: TOKEN, fetchImpl, retryDelayMs: 0 });
  assert.equal((await gh.events('a/b')).length, 100);
  assert.equal(pages, 2);
  assert.throws(() => createGitHub({ token: null }), /GITHUB_TOKEN/);
});

test('checkRepo: rejects non-repo input and accepts GitHub URLs', async () => {
  await assert.rejects(checkRepo('not a repo', { token: TOKEN, fetchImpl: async () => res({}) }), /owner\/repo/);
  const fx = buildFixture('quiet');
  const r = await checkRepo(`https://github.com/${fx.full}.git`, { token: TOKEN, fetchImpl: fixtureFetch(fx), retryDelayMs: 0, lockstep: false });
  assert.equal(r.repo, fx.full);
});

test('redact scrubs GitHub tokens, env credentials and registered secrets', () => {
  assert.equal(redact(`token ${TOKEN}`), 'token [redacted]');
  assert.equal(redact('github_pat_' + 'a'.repeat(40)), '[redacted]');
  assert.equal(redact('Authorization: Bearer abcdefghijklmnopqrstuvwxyz'), 'Authorization: Bearer [redacted]');
  registerSecret('plain-secret-value-123');
  assert.equal(redact('oops plain-secret-value-123'), 'oops [redacted]');
  process.env.SOME_API_KEY = 'env-secret-value-456';
  assert.equal(redact('x env-secret-value-456 y'), 'x [redacted] y');
  delete process.env.SOME_API_KEY;
});

test('npm: repository URLs map to owner/repo; package.json deps resolve through the registry', async () => {
  assert.equal(githubRepoFromUrl('git+https://github.com/a-b/c.d.git'), 'a-b/c.d');
  assert.equal(githubRepoFromUrl('github:a/b'), 'a/b');
  assert.equal(githubRepoFromUrl('git+ssh://github.com/a/b.git'), 'a/b');
  assert.equal(githubRepoFromUrl('https://github.com/a/b/tree/main/packages/x'), 'a/b');
  assert.equal(githubRepoFromUrl('https://gitlab.com/a/b'), null);
  const fetchImpl = async (url) => res(String(url).includes('left-pad-fake') ? { repository: { url: 'git+https://github.com/nonexistent-labs/left-pad-fake.git' } } : { name: 'x' });
  const out = await reposForPackage({ dependencies: { 'left-pad-fake': '1', '@scope/none': '2' }, devDependencies: { dev: '1' } }, { fetchImpl });
  assert.deepEqual(out, [{ name: 'left-pad-fake', repo: 'nonexistent-labs/left-pad-fake' }, { name: '@scope/none', repo: null }]);
});

test('markdown: escapes table cells and keeps the caveat', async () => {
  const { report } = await run('suspicious');
  const md = markdown([report, { repo: 'bad|name', error: 'not found' }]);
  assert.match(md, /\| nonexistent-labs\/widget-kit \| 3,758 \| STRONG SIGNALS consistent with inorganic stars \|/);
  assert.match(md, /bad\\\|name/);
  for (const c of report.caveats) assert.ok(md.includes(c), `markdown is missing caveat: ${c}`);
  assert.ok(!/paid target/i.test(md));
});

test('CLI: help with no arguments exits 2, bad --fail-on exits 2', () => {
  const env = { ...process.env, GITHUB_TOKEN: '', GH_TOKEN: '' };
  const a = spawnSync(process.execPath, [BIN], { encoding: 'utf8', env });
  assert.equal(a.status, 2);
  assert.match(a.stdout, /fake-star-check <owner\/repo>/);
  const b = spawnSync(process.execPath, [BIN, 'a/b', '--fail-on', 'maybe'], { encoding: 'utf8', env });
  assert.equal(b.status, 2);
  const c = spawnSync(process.execPath, [BIN, '--help'], { encoding: 'utf8', env });
  assert.equal(c.status, 0);
});

test('wording: labels name signals, not verdicts; JSON carries no third-party repo names from lockstep', async () => {
  const { report } = await run('suspicious');
  assert.equal(report.assessment.label, 'STRONG SIGNALS consistent with inorganic stars');
  const lock = report.checks.find((c) => c.id === 'lockstep');
  assert.equal(lock.data.coStarredSample, undefined);
  assert.equal(typeof lock.data.coStarredRepos, 'number');
  const json = JSON.stringify(report);
  assert.ok(!json.includes('bigco/'), 'co-starred repo names leaked into JSON');
  assert.ok(!/paid target/i.test(json + text(report)));
  for (const c of report.caveats) assert.ok(text(report).replace(/\s+/g, ' ').includes(c));
});

test('cache: GitHub keys are scoped to the token, files are 0600', async () => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const { fileCache } = await import('../src/cache.mjs');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fsc-'));
  const cache = fileCache({ dir });
  let calls = 0;
  const fetchImpl = async () => { calls++; return res({ full_name: 'a/b', stargazers_count: calls }); };
  const a = createGitHub({ token: 'ghp_' + 'A'.repeat(36), fetchImpl, cache });
  const b = createGitHub({ token: 'ghp_' + 'B'.repeat(36), fetchImpl, cache });
  assert.equal((await a.repo('a/b')).stargazers_count, 1);
  assert.equal((await a.repo('a/b')).stargazers_count, 1, 'same token reuses the cache');
  assert.equal((await b.repo('a/b')).stargazers_count, 2, 'another token must not get the first token\'s data');
  const files = fs.readdirSync(dir);
  assert.equal(files.length, 2);
  for (const f of files) {
    if (process.platform !== 'win32') assert.equal(fs.statSync(path.join(dir, f)).mode & 0o777, 0o600);
    assert.ok(!fs.readFileSync(path.join(dir, f), 'utf8').includes('ghp_'));
  }
  fs.rmSync(dir, { recursive: true, force: true });
});

test('CLI: everything after -- is a repo name, never an option', () => {
  const env = { ...process.env, GITHUB_TOKEN: 'fixture-token-not-real-0000', GH_TOKEN: '' };
  // "--file x" after -- must be rejected as a repo name (before any network call), not read as a file.
  const r = spawnSync(process.execPath, [BIN, '--json', '--no-cache', '--', '--file', BIN], { encoding: 'utf8', env });
  assert.notEqual(r.status, 0);
  assert.ok(!r.stdout.includes('#!/usr/bin/env node'), 'file contents were read');
  assert.match(r.stdout, /not an owner\/repo/);
  assert.ok(!(r.stdout + r.stderr).includes('fixture-token-not-real'));
});
