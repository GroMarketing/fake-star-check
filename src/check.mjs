/**
 * checkRepo(): gather public data for one repo and run every check.
 *
 * Request budget per repo, with the default sample of 60: 1 repo lookup,
 * up to 3 event pages, about 3 GraphQL calls, up to 60 star-history pages for
 * the lockstep check, 1 search for peers, and 3 OSS Insight calls. Nothing
 * scales with the repo's star count, so a repo with 300,000 stars costs the
 * same as one with 300.
 */
import { createGitHub, resolveToken, isRepoName } from './github.mjs';
import { createOssInsight, dailyDeltas, monthlyDeltas } from './ossinsight.mjs';
import { ApiError } from './http.mjs';
import { noCache } from './cache.mjs';
import { sampleStars, feedCoverage, profileCheck, lockstepCheck, burstCheck, removalCheck, ratioCheck, activityCheck, assess, CAVEATS, DEFAULTS } from './signals.mjs';

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  }));
  return out;
}

function restUser(u) {
  return {
    login: u.login,
    createdAt: u.created_at,
    updatedAt: u.updated_at,
    bio: u.bio || '',
    company: u.company || '',
    website: u.blog || '',
    followers: u.followers ?? 0,
    following: u.following ?? 0,
    repos: u.public_repos ?? 0,
    gists: u.public_gists ?? 0,
    starred: null,
    orgs: null,
    contributions: null,
  };
}

/**
 * @param {string} full  "owner/repo"
 * @param {object} o
 *   token, fetchImpl, cache, sample (60), lockstep (true), peers (true),
 *   history (true), onProgress(msg), retryDelayMs, now (Date, for tests)
 */
export async function checkRepo(full, o = {}) {
  full = String(full).trim().replace(/^https?:\/\/github\.com\//i, '').replace(/\.git$/, '').replace(/\/+$/, '');
  if (!isRepoName(full)) throw new Error(`"${full}" is not an owner/repo name.`);
  const progress = o.onProgress || (() => {});
  const cache = o.cache || noCache;
  const gh = o.github || createGitHub({ token: o.token ?? resolveToken(), fetchImpl: o.fetchImpl, cache, retryDelayMs: o.retryDelayMs });
  const oss = o.ossinsight || createOssInsight({ fetchImpl: o.fetchImpl, cache, retryDelayMs: o.retryDelayMs });
  const sampleSize = o.sample ?? 60;
  const notes = [];

  progress(`${full}: repo`);
  let repo;
  try {
    repo = await gh.repo(full);
  } catch (e) {
    if (e instanceof ApiError && e.status === 404) throw new Error(`${full}: not found (or private).`);
    throw e;
  }
  full = repo.full_name || full;

  progress(`${full}: recent events`);
  const events = await gh.events(full);
  const coverage = feedCoverage(events, repo.stargazers_count);
  const { sample } = sampleStars(events, sampleSize);

  progress(`${full}: ${sample.length} stargazer profiles`);
  const users = sample.length ? await gh.users(sample.map((s) => s.login)) : new Map();
  const deleted = new Set();
  const restricted = new Set();
  // GraphQL answers NOT_FOUND for deleted accounts and also for some accounts
  // that REST still serves. Lookups that failed for other reasons fall back to
  // REST quietly. Either way the account still counts in the profile stats.
  const lookups = sample.map((s) => s.login).filter((l) => !users.get(l));
  await mapLimit(lookups, 4, async (login) => {
    const notFound = users.has(login);
    try {
      const u = await gh.restUser?.(login);
      if (u) {
        users.set(login, restUser(u));
        if (notFound) restricted.add(login);
      }
    } catch (e) {
      if (e instanceof ApiError && e.status === 404) deleted.add(login);
    }
  });

  const checks = [];
  checks.push(profileCheck({ sample, users, deleted, restricted, coverage, starCount: repo.stargazers_count, opts: o.thresholds }));

  if (o.lockstep !== false && sample.length >= 10) {
    const budget = gh.rate?.remaining;
    if (budget != null && budget < sample.length + 30) {
      notes.push(`Skipped the lockstep check: only ${budget} GitHub API requests left this hour.`);
      checks.push({ id: 'lockstep', title: 'Accounts starring in lockstep', level: 'n/a', evidence: ['Skipped to stay inside the GitHub rate limit.'], data: {} });
    } else {
      progress(`${full}: star histories of ${sample.length} stargazers`);
      const lists = new Map();
      await mapLimit(sample, 4, async (s) => {
        try {
          lists.set(s.login, await gh.starred(s.login));
        } catch {
          // Deleted or restricted account; leave it out.
        }
      });
      checks.push(lockstepCheck({ lists, target: full, starCount: repo.stargazers_count, opts: o.thresholds }));
    }
  }

  if (o.history !== false) {
    progress(`${full}: star history (OSS Insight)`);
    try {
      const [stars, issues, prs] = await Promise.all([
        oss.starsDaily(full),
        oss.issueCreatorsMonthly(full).catch(() => []),
        oss.prCreatorsMonthly(full).catch(() => []),
      ]);
      const burst = burstCheck({ daily: dailyDeltas(stars), issueMonthly: monthlyDeltas(issues), prMonthly: monthlyDeltas(prs), quality: stars.quality || null, opts: o.thresholds });
      checks.push(burst);
      checks.push(removalCheck({ starEvents: burst.data.starEvents, githubStars: repo.stargazers_count }));
    } catch (e) {
      notes.push(`Star history unavailable: ${e.message}`);
      checks.push({ id: 'bursts', title: 'Star bursts over time', level: 'n/a', evidence: ['OSS Insight did not return star history for this repo.'], data: {} });
    }
  }

  let peers = null;
  if (o.peers !== false) {
    progress(`${full}: comparable repos`);
    try {
      peers = await gh.peers(repo);
    } catch (e) {
      notes.push(`Peer comparison unavailable: ${e.message}`);
    }
  }
  checks.push(ratioCheck({ repo, peers }));
  checks.push(activityCheck({ events }));

  return {
    repo: full,
    checkedAt: (o.now || new Date()).toISOString(),
    stars: repo.stargazers_count,
    forks: repo.forks_count,
    watchers: repo.subscribers_count ?? null,
    openIssues: repo.open_issues_count,
    language: repo.language || null,
    createdAt: repo.created_at,
    assessment: assess(checks),
    checks,
    method: {
      sample: { requested: sampleSize, used: sample.length, recentStarsInFeed: coverage.stars, feedDays: coverage.days, feedFrom: coverage.from, feedTo: coverage.to },
      thresholds: { ...DEFAULTS, ...(o.thresholds || {}) },
      sources: ['GitHub REST: repo, public events, user profiles, users\' starred repos, search', 'GitHub GraphQL: user profiles', 'OSS Insight (GH Archive): daily star history, monthly new issue and PR authors'],
      reference: 'He et al., "Six Million (Suspected) Fake Stars on GitHub", ICSE 2026, doi:10.1145/3744916.3764531',
    },
    notes,
    caveats: CAVEATS,
  };
}
