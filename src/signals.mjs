/**
 * The checks. Every function here is pure: data in, a check out. A check is
 *
 *   { id, title, level, evidence: [string], data: {...} }
 *
 * where level is 'none' | 'weak' | 'moderate' | 'strong' | 'n/a'. Evidence is
 * written as plain sentences with the numbers behind them, so a reader can
 * disagree with the level and still use the facts.
 *
 * Detection ideas follow He et al., "Six Million (Suspected) Fake Stars on
 * GitHub" (ICSE 2026, doi:10.1145/3744916.3764531), which describes a
 * low-activity heuristic and a lockstep (CopyCatch) heuristic. This file is an
 * independent, sampled re-implementation for a single repo, not their code.
 */

const DAY = 86400000;
export const LEVELS = ['none', 'weak', 'moderate', 'strong'];
const rank = (l) => Math.max(0, LEVELS.indexOf(l));
const cap = (level, max) => (rank(level) > rank(max) ? max : level);
const pct = (a, b) => (b ? Math.round((100 * a) / b) : 0);
const fmt = (n) => Number(n).toLocaleString('en-US');
const median = (xs) => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const plural = (n, one, many = one + 's') => `${fmt(n)} ${n === 1 ? one : many}`;
const sameDay = (a, b) => Boolean(a && b) && a.slice(0, 10) === b.slice(0, 10);

export const DEFAULTS = {
  newAccountDays: 30,
  lowFollowers: 3,
  lowRepos: 2,
  lockstepWindowDays: 15,
  lockstepMinShared: 5,
  lockstepMinPartners: 3,
  burstMinStars: 20,
  burstTrailingDays: 28,
};

/**
 * Pick up to `size` stars from the event feed, spread evenly across it so a
 * single busy hour does not dominate. One entry per login.
 */
export function sampleStars(events, size = 60) {
  const seen = new Set();
  const stars = [];
  for (const e of events) {
    if (e.type !== 'WatchEvent' || !e.actor?.login || seen.has(e.actor.login)) continue;
    seen.add(e.actor.login);
    stars.push({ login: e.actor.login, at: e.created_at });
  }
  if (stars.length <= size) return { all: stars, sample: stars };
  const step = stars.length / size;
  return { all: stars, sample: Array.from({ length: size }, (_, i) => stars[Math.floor(i * step)]) };
}

/** What the event feed covers: how many days, how many stars, and what share of the repo's stars that is. */
export function feedCoverage(events, starCount) {
  const times = events.map((e) => Date.parse(e.created_at)).filter(Number.isFinite);
  const stars = events.filter((e) => e.type === 'WatchEvent').length;
  if (!times.length) return { events: 0, stars: 0, days: 0, from: null, to: null, shareOfStars: 0 };
  const from = new Date(Math.min(...times)).toISOString();
  const to = new Date(Math.max(...times)).toISOString();
  return {
    events: events.length,
    stars,
    days: Math.max(1, Math.round((Date.parse(to) - Date.parse(from)) / DAY)),
    from,
    to,
    shareOfStars: starCount ? stars / starCount : 0,
  };
}

/**
 * Who starred recently. `users` maps login -> profile. `deleted` holds logins
 * whose accounts no longer exist; `restricted` holds logins GitHub's GraphQL
 * API will not return although REST still serves them.
 */
export function profileCheck({ sample, users, deleted = new Set(), restricted = new Set(), coverage, starCount, opts = {} }) {
  const o = { ...DEFAULTS, ...opts };
  const id = 'profiles';
  const title = 'Who starred recently';
  const known = sample.filter((s) => users.get(s.login));
  if (sample.length < 10) {
    return { id, title, level: 'n/a', evidence: [`Only ${plural(sample.length, 'recent stargazer')} in GitHub's event feed, too few to judge.`], data: { sampled: sample.length } };
  }
  let fresh = 0;
  let sameDayAsStar = 0;
  let throwaway = 0;
  let starscout = 0;
  let noFollowers = 0;
  const ages = [];
  for (const s of known) {
    const u = users.get(s.login);
    const age = (Date.parse(s.at) - Date.parse(u.createdAt)) / DAY;
    ages.push(age);
    const isNew = age < o.newAccountDays;
    const thin = u.followers <= o.lowFollowers && u.repos <= o.lowRepos;
    if (isNew) fresh++;
    if (sameDay(u.createdAt, s.at)) sameDayAsStar++;
    if (isNew && thin) throwaway++;
    if (u.followers === 0) noFollowers++;
    // The ICSE 2026 low-activity profile, minus the public-email test
    // (reading email needs an extra token scope).
    if (u.followers < 2 && u.following < 2 && u.gists === 0 && u.repos < 5 && u.createdAt >= '2022-01-01' && !u.bio && sameDay(u.createdAt, s.at) && sameDay(u.updatedAt, u.createdAt)) starscout++;
  }
  const n = sample.length;
  const deletedCount = sample.filter((s) => deleted.has(s.login)).length;
  const restrictedCount = sample.filter((s) => restricted.has(s.login)).length;
  const flagged = new Set(known.filter((s) => {
    const u = users.get(s.login);
    return (Date.parse(s.at) - Date.parse(u.createdAt)) / DAY < o.newAccountDays && u.followers <= o.lowFollowers && u.repos <= o.lowRepos;
  }).map((s) => s.login));
  for (const s of sample) if (deleted.has(s.login)) flagged.add(s.login);
  const share = flagged.size / n;

  const evidence = [
    `${pct(throwaway, n)}% of ${n} sampled recent stargazers (${throwaway}) starred within ${o.newAccountDays} days of creating their account and have at most ${o.lowFollowers} followers and ${o.lowRepos} repos.`,
  ];
  if (sameDayAsStar) evidence.push(`${pct(sameDayAsStar, n)}% (${sameDayAsStar}) starred on the same day the account was created.`);
  if (deletedCount) evidence.push(`${pct(deletedCount, n)}% (${deletedCount}) starred and then their account disappeared (deleted or suspended), counted as flagged.`);
  if (restrictedCount) evidence.push(`${restrictedCount} ${restrictedCount === 1 ? 'is' : 'are'} hidden from GitHub's GraphQL API but still visible through REST. GitHub does not say why; restricted accounts are one explanation. Not counted on its own.`);
  if (starscout) evidence.push(`${starscout} match the stricter low-activity profile from the ICSE 2026 study (new, empty, and untouched since the day they starred).`);
  if (ages.length) evidence.push(`Median account age at the time of the star: ${fmt(Math.round(median(ages)))} days. ${pct(noFollowers, known.length)}% have no followers.`);

  let level = share >= 0.4 ? 'strong' : share >= 0.2 ? 'moderate' : share >= 0.1 ? 'weak' : 'none';
  // A popular repo collects stars from throwaway accounts that use it as cover.
  // When the feed covers a sliver of the repo's stars, the sample says little
  // about how the total was earned.
  if (level !== 'none' && coverage && starCount >= 5000 && coverage.shareOfStars < 0.02) {
    level = cap(level, 'weak');
    evidence.push(`The sample covers the last ${plural(coverage.days, 'day')} (${fmt(coverage.stars)} stars, under 2% of ${fmt(starCount)}). Accounts like these also star popular repos to look normal, so at this size they say little about how the total was earned.`);
  }
  return {
    id,
    title,
    level,
    evidence,
    data: { sampled: n, profilesRead: known.length, throwaway, sameDayAsStar, deleted: deletedCount, restricted: restrictedCount, starscoutProfile: starscout, flaggedShare: Number(share.toFixed(3)), medianAgeDays: Math.round(median(ages)) },
  };
}

/**
 * Lockstep: do sampled stargazers star the same other repos at the same time?
 * `lists` maps login -> [{ repo, at, stars }] (their most recent stars).
 * Two accounts are linked when they share at least `lockstepMinShared` other
 * repos starred within `lockstepWindowDays` of each other; an account is in
 * lockstep when it is linked to at least `lockstepMinPartners` others.
 */
export function lockstepCheck({ lists, target, starCount, opts = {} }) {
  const o = { ...DEFAULTS, ...opts };
  const id = 'lockstep';
  const title = 'Accounts starring in lockstep';
  const logins = [...lists.keys()].filter((l) => lists.get(l)?.length);
  if (logins.length < 10) {
    return { id, title, level: 'n/a', evidence: [`Star histories were readable for only ${plural(logins.length, 'account')}, too few to look for coordination.`], data: { accounts: logins.length } };
  }
  const t = target.toLowerCase();
  const maps = new Map(logins.map((l) => [l, new Map(lists.get(l).filter((s) => s.repo && s.repo.toLowerCase() !== t).map((s) => [s.repo, Date.parse(s.at)]))]));
  const repoStars = new Map();
  for (const l of logins) for (const s of lists.get(l)) if (s.repo && s.stars != null) repoStars.set(s.repo, s.stars);
  const partners = new Map(logins.map((l) => [l, new Set()]));
  const sharedRepos = new Map();
  const win = o.lockstepWindowDays * DAY;
  for (let i = 0; i < logins.length; i++) {
    for (let j = i + 1; j < logins.length; j++) {
      const a = maps.get(logins[i]);
      const b = maps.get(logins[j]);
      const [small, big] = a.size < b.size ? [a, b] : [b, a];
      const shared = [];
      for (const [repo, ta] of small) {
        const tb = big.get(repo);
        if (tb != null && Math.abs(ta - tb) <= win) shared.push(repo);
      }
      if (shared.length >= o.lockstepMinShared) {
        partners.get(logins[i]).add(logins[j]);
        partners.get(logins[j]).add(logins[i]);
        for (const r of shared) sharedRepos.set(r, (sharedRepos.get(r) || 0) + 1);
      }
    }
  }
  const inLockstep = logins.filter((l) => partners.get(l).size >= o.lockstepMinPartners);
  const n = logins.length;
  const share = inLockstep.length / n;
  const evidence = [];
  const coStarred = [...sharedRepos.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([repo]) => repo);
  const coStars = coStarred.map((r) => repoStars.get(r)).filter((x) => x != null);
  const medCo = median(coStars);
  if (!inLockstep.length) {
    evidence.push(`None of the ${n} accounts checked share a pattern of starring the same repos at the same time.`);
  } else {
    evidence.push(`${pct(inLockstep.length, n)}% of ${n} sampled stargazers (${inLockstep.length}) each starred at least ${o.lockstepMinShared} of the same other repos within ${o.lockstepWindowDays} days of at least ${o.lockstepMinPartners} other sampled stargazers.`);
  }
  let level = share >= 0.25 ? 'strong' : share >= 0.1 ? 'moderate' : inLockstep.length >= 3 ? 'weak' : 'none';
  let pattern = null;
  if (inLockstep.length >= 3 && coStars.length) {
    if (starCount >= medCo * 0.5) {
      pattern = 'cover';
      evidence.push(`The repos they star together have a median of ${fmt(Math.round(medCo))} stars, and this repo is in that league. Coordinated accounts star popular repos as cover, so this pattern is common on well-known repos and does not by itself point at the owner.`);
      level = cap(level, 'weak');
    } else if (starCount < medCo * 0.05) {
      pattern = 'odd-one-out';
      evidence.push(`The repos they star together have a median of ${fmt(Math.round(medCo))} stars, far more than this repo's ${fmt(starCount)}. Accounts starring one small repo alongside much bigger ones is a pattern consistent with inorganic stars. Accounts can star any repo without its owner's involvement.`);
    }
  }
  return { id, title, level, evidence, data: { accounts: n, inLockstep: inLockstep.length, share: Number(share.toFixed(3)), pattern, coStarredMedianStars: Math.round(medCo), coStarredRepos: sharedRepos.size } };
}

/**
 * Star bursts over the repo's whole history (daily new stars from GH Archive),
 * with new issue and PR authors in the same months as a reality check: a real
 * launch brings people who also file issues and send PRs.
 */
export function burstCheck({ daily, issueMonthly = new Map(), prMonthly = new Map(), quality = null, opts = {} }) {
  const o = { ...DEFAULTS, ...opts };
  const id = 'bursts';
  const title = 'Star bursts over time';
  if (!daily?.length) {
    return { id, title, level: 'n/a', evidence: ['No star history was available from OSS Insight for this repo.'], data: {} };
  }
  const total = daily.reduce((a, d) => a + d.n, 0);
  const degradedFrom = quality?.suspect_since || quality?.unavailable_since || null;
  const severeFrom = quality?.severely_degraded_since || null;
  const flagged = [];
  for (let i = 0; i < daily.length; i++) {
    const trail = daily.slice(Math.max(0, i - o.burstTrailingDays), i).map((d) => d.n);
    const med = median(trail);
    const mad = median(trail.map((x) => Math.abs(x - med)));
    const mean = trail.length ? trail.reduce((a, b) => a + b, 0) / trail.length : 0;
    const threshold = Math.max(o.burstMinStars, med + 8 * 1.4826 * Math.max(mad, 1), 5 * Math.max(mean, 1));
    if (daily[i].n >= threshold) flagged.push(i);
  }
  const windows = [];
  for (const i of flagged) {
    const w = windows.at(-1);
    if (w && i - w.end <= 2) w.end = i;
    else windows.push({ start: i, end: i });
  }
  const firstStar = daily.findIndex((d) => d.n > 0);
  const months = [...new Set(daily.map((d) => d.date.slice(0, 7)))];
  const medianMonthly = (m) => {
    const idx = months.indexOf(m);
    const prior = months.slice(Math.max(0, idx - 12), idx);
    return { issues: median(prior.map((k) => issueMonthly.get(k) || 0)), prs: median(prior.map((k) => prMonthly.get(k) || 0)) };
  };
  const described = windows.map((w) => {
    const days = daily.slice(w.start, w.end + 1);
    const stars = days.reduce((a, d) => a + d.n, 0);
    let best2 = 0;
    for (let i = w.start; i <= w.end; i++) best2 = Math.max(best2, daily[i].n + (daily[i + 1]?.n || 0));
    const month = daily[w.start].date.slice(0, 7);
    const base = medianMonthly(month);
    const before = median(daily.slice(Math.max(0, w.start - o.burstTrailingDays), w.start).map((d) => d.n));
    return {
      from: daily[w.start].date,
      to: daily[w.end].date,
      days: days.length,
      stars,
      peak2Days: best2,
      shareOfTotal: total ? stars / total : 0,
      baselinePerDay: before,
      month,
      newIssueAuthors: issueMonthly.get(month) || 0,
      newPrAuthors: prMonthly.get(month) || 0,
      typicalIssueAuthors: base.issues,
      typicalPrAuthors: base.prs,
      nearCreation: firstStar >= 0 && w.start - firstStar <= 14,
      activityRose: (issueMonthly.get(month) || 0) + (prMonthly.get(month) || 0) > 2 * Math.max(1, base.issues + base.prs),
      activityKnown: !degradedFrom || daily[w.start].date < degradedFrom,
    };
  }).sort((a, b) => b.stars - a.stars);

  const evidence = [];
  const peak = (k) => {
    let best = { stars: 0, from: null, to: null };
    let sum = 0;
    for (let i = 0; i < daily.length; i++) {
      sum += daily[i].n - (i >= k ? daily[i - k].n : 0);
      if (sum > best.stars) best = { stars: sum, from: daily[Math.max(0, i - k + 1)].date, to: daily[i].date };
    }
    return best;
  };
  const p2 = peak(2);
  const p7 = peak(7);
  if (total) evidence.push(`Busiest 2 days: ${fmt(p2.stars)} stars (${p2.from} to ${p2.to}). Busiest 7 days: ${fmt(p7.stars)} stars, ${pct(p7.stars, total)}% of all star events.`);
  const concentrated = p7.stars >= 1000 && p7.stars / total >= 0.25;
  const significant = described.filter((b) => b.stars >= 100 && b.shareOfTotal >= 0.05);
  let level = 'none';
  if (!described.length) {
    evidence.push(`No unusual spikes in ${fmt(daily.length)} days of star history (${fmt(total)} star events).`);
  }
  for (const b of described.slice(0, 3)) {
    const span = b.days <= 2 ? `${fmt(b.stars)} stars in ${b.days === 1 ? '1 day' : '2 days'}` : `${fmt(b.stars)} stars in ${b.days} days (peak ${fmt(b.peak2Days)} in 2 days)`;
    const ctx = [`${b.from}${b.to !== b.from ? ` to ${b.to}` : ''}: ${span}, ${pct(b.stars, total)}% of all star events, against a usual ${fmt(Math.round(b.baselinePerDay))} a day.`];
    if (b.activityKnown) ctx.push(`New issue authors that month: ${fmt(b.newIssueAuthors)}, new PR authors: ${fmt(b.newPrAuthors)} (typical month: ${fmt(Math.round(b.typicalIssueAuthors))} and ${fmt(Math.round(b.typicalPrAuthors))}).`);
    else ctx.push('Issue and PR author counts for this period are not reliable (see the data note below), so they are not compared.');
    if (b.nearCreation) ctx.push('This is in the first two weeks of the repo, when launches happen.');
    evidence.push(ctx.join(' '));
  }
  if (significant.length) {
    const top = significant[0];
    level = top.activityKnown && top.activityRose ? 'weak' : 'moderate';
    evidence.push(top.activityKnown && top.activityRose
      ? 'Issue and PR activity rose in the same month, which is what a real launch looks like. A burst alone is consistent with a launch (for example a Hacker News front page) or with purchased stars.'
      : `${top.activityKnown ? 'Issue and PR activity did not rise with it. ' : ''}A burst alone is consistent with a launch (for example a Hacker News front page) or with purchased stars; it is evidence only alongside the account checks.`);
  } else if (concentrated) {
    level = 'moderate';
    evidence.push(`A quarter or more of all stars arrived in one week. That is consistent with a launch (for example a Hacker News front page) or with purchased stars; it is evidence only alongside the account checks.`);
  } else if (described.length) {
    evidence.push('The spikes are small relative to the repo\'s total, so they are not counted as a signal.');
  }
  if (degradedFrom && daily.at(-1).date >= degradedFrom) {
    evidence.push(`Data note: OSS Insight marks its event-derived counts as lower bounds from ${degradedFrom}${severeFrom ? ` (severely degraded from ${severeFrom})` : ''}, because of changes to GitHub's public event feed. Bursts in that period can be understated or missed.`);
  }
  return { id, title, level, evidence, data: { days: daily.length, starEvents: total, busiest2Days: p2, busiest7Days: p7, bursts: described.slice(0, 5), degradedFrom, severeFrom } };
}

/**
 * Stars that were recorded in the public event stream but are no longer
 * counted by GitHub. People unstar, and GitHub removes stars when it deletes
 * or restricts accounts; removal on a large scale is unusual.
 */
export function removalCheck({ starEvents, githubStars }) {
  const id = 'removed';
  const title = 'Stars that disappeared';
  if (!starEvents || githubStars == null) return { id, title, level: 'n/a', evidence: ['No star history to compare with.'], data: {} };
  const gone = Math.max(0, starEvents - githubStars);
  const share = gone / starEvents;
  const evidence = [`GitHub counts ${fmt(githubStars)} stars; the public event stream recorded ${fmt(starEvents)} star events${gone ? `, so at least ${fmt(gone)} (${pct(gone, starEvents)}%) are gone` : ''}.`];
  let level = 'none';
  if (share >= 0.5 && gone >= 200) level = 'moderate';
  else if (share >= 0.25 && gone >= 100) level = 'weak';
  if (level !== 'none') evidence.push('Stars disappear when people unstar and when GitHub removes accounts. Losing this share is unusual and fits an earlier wave of stars from accounts that were later removed.');
  else if (gone) evidence.push('A loss this size is normal churn from people unstarring.');
  evidence.push('Event-stream counts are lower bounds, so the real loss can be larger.');
  return { id, title, level, evidence, data: { githubStars, starEvents, gone, share: Number(share.toFixed(3)) } };
}

/** Forks per star against repos of similar size and language. */
export function ratioCheck({ repo, peers }) {
  const id = 'ratios';
  const title = 'Forks and watchers per star';
  const s = repo.stargazers_count;
  const own = s ? repo.forks_count / s : 0;
  const evidence = [`${fmt(s)} stars, ${fmt(repo.forks_count)} forks (${(own * 100).toFixed(1)} per 100 stars), ${fmt(repo.subscribers_count ?? 0)} watchers, ${fmt(repo.open_issues_count)} open issues and PRs.`];
  if (!peers || peers.length < 20 || s < 50) {
    evidence.push('Not enough comparable repos to compare against.');
    return { id, title, level: 'n/a', evidence, data: { forksPer100Stars: Number((own * 100).toFixed(2)), peers: peers?.length || 0 } };
  }
  const ratios = peers.filter((p) => p.stars).map((p) => p.forks / p.stars).sort((a, b) => a - b);
  const below = ratios.filter((r) => r < own).length;
  const percentile = Math.round((100 * below) / ratios.length);
  const where = percentile === 0 ? 'this repo has fewer forks per star than all of them' : `this repo is at the ${ordinal(percentile)} percentile`;
  evidence.push(`Among ${ratios.length} repos with a similar star count${repo.language ? ` in ${repo.language}` : ''}, the median is ${(median(ratios) * 100).toFixed(1)} forks per 100 stars; ${where}.`);
  let level = 'none';
  if (percentile <= 5) {
    level = 'weak';
    evidence.push('Few forks for its stars. Lists, docs and design repos are often like this legitimately, so this only adds weight to other signals.');
  }
  return { id, title, level, evidence, data: { forksPer100Stars: Number((own * 100).toFixed(2)), peers: ratios.length, peerMedianForksPer100Stars: Number((median(ratios) * 100).toFixed(2)), percentile } };
}

/** In the event feed window: how many stars arrived alongside forks, issues and PRs. */
export function activityCheck({ events }) {
  const id = 'activity';
  const title = 'What else happened while the stars arrived';
  const count = (type, action) => events.filter((e) => e.type === type && (!action || e.payload?.action === action)).length;
  const stars = count('WatchEvent');
  const forks = count('ForkEvent');
  const issues = count('IssuesEvent', 'opened');
  const prs = count('PullRequestEvent', 'opened');
  const pushes = count('PushEvent');
  const cov = feedCoverage(events, 0);
  const evidence = [`In the last ${plural(cov.days, 'day')} of public events: ${plural(stars, 'star')}, ${plural(forks, 'fork')}, ${plural(issues, 'issue')} opened, ${plural(prs, 'PR')} opened, ${plural(pushes, 'push', 'pushes')}.`];
  let level = stars < 30 ? 'n/a' : 'none';
  if (stars >= 30 && forks + issues + prs === 0) {
    level = 'weak';
    evidence.push('Stars arrived with no forks, issues or PRs at all. Real attention usually brings at least a few.');
  }
  return { id, title, level, evidence, data: { stars, forks, issues, prs, pushes, days: cov.days } };
}

function ordinal(n) {
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}

/**
 * Combine the checks into one assessment. Account-level evidence (who starred,
 * and whether they move together) carries the weight; bursts and ratios can
 * support it but never make the call alone.
 */
export function assess(checks) {
  const by = Object.fromEntries(checks.map((c) => [c.id, c]));
  const r = (id) => (by[id] && by[id].level !== 'n/a' ? rank(by[id].level) : 0);
  const account = Math.max(r('profiles'), r('lockstep'));
  const points = checks.reduce((a, c) => a + (c.level === 'n/a' ? 0 : rank(c.level)), 0);
  const raised = checks.filter((c) => c.level !== 'n/a' && rank(c.level) > 0).length;
  const counted = checks.filter((c) => c.level !== 'n/a').length;
  // Account checks that ran on a decent sample and found nothing count against
  // a burst-only reading.
  const clean = ['profiles', 'lockstep'].every((id) => by[id] && by[id].level === 'none') && (by.profiles?.data?.sampled || 0) >= 30;
  let level;
  if (account === 3 && points >= 5) level = 'strong';
  else if (account >= 2 || (r('bursts') >= 2 && !clean) || points >= 3) level = 'some';
  else if (points >= 1) level = 'weak';
  else level = 'none';

  const label = { strong: 'STRONG SIGNALS consistent with inorganic stars', some: 'SOME SIGNALS consistent with inorganic stars', weak: 'WEAK SIGNALS consistent with inorganic stars', none: 'NO NOTABLE SIGNALS' }[level];
  let summary;
  if (level === 'none') summary = 'None of the checks found patterns associated with fake stars.';
  else if (account === 0 && r('bursts') >= 1 && clean) summary = 'Star bursts, but the recent stargazers checked look like ordinary accounts. Consistent with a launch (for example a Hacker News front page). The account sample only covers recent stars, so it cannot clear the burst itself.';
  else if (account === 0 && r('bursts') >= 1) summary = 'Star bursts without account-level evidence. That is consistent with a launch (for example a Hacker News front page) or with purchased stars.';
  else if (level === 'strong') summary = 'Several independent checks point the same way: recent stargazers look like throwaway or coordinated accounts, and other signals agree.';
  else if (account >= 2) summary = 'Recent stargazers include a notable share of throwaway or coordinated accounts. Other checks do not strongly confirm it.';
  else summary = 'A few weak signals. Each has ordinary explanations.';
  return { level, label, summary, raised, counted, accountChecksClean: clean };
}

export const CAVEATS = [
  'This is a heuristic read of public data, not proof. Every signal here has innocent explanations, and no check can tell who paid for a star.',
  'GitHub no longer lists stargazers, so account checks use only the stars in the repo\'s recent public event feed (at most 300 events, at most 90 days). Stars bought earlier are not in that sample.',
  'Accounts that sell stars also star popular repos to look normal, so even well-known projects collect some of them.',
];
