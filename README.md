# fake-star-check

Look for signs of fake GitHub stars, and see the evidence behind each one.
Point it at a repo (or at your `package.json`) and it tells you who starred
recently, whether those accounts move in lockstep, whether the stars arrived in
a burst, how many stars later disappeared, and how the repo's forks compare
with similar repos. It is read-only, and it is a heuristic, not proof.

```
$ npx fake-star-check nonexistent-labs/widget-kit

nonexistent-labs/widget-kit
3,758 stars, 61 forks, 9 watchers, TypeScript, created 2026-03-02

Assessment: STRONG SIGNALS consistent with inorganic stars (4 of 6 checks raised something)
Several independent checks point the same way: recent stargazers look like throwaway or
coordinated accounts, and other signals agree.

[strong]    Who starred recently
            43% of 60 sampled recent stargazers (26) starred within 30 days of creating
            their account and have at most 3 followers and 2 repos.
            13% (8) starred on the same day the account was created.
            3% (2) starred and then their account disappeared (deleted or suspended),
            counted as flagged.
            8 match the stricter low-activity profile from the ICSE 2026 study (new, empty,
            and untouched since the day they starred).
            Median account age at the time of the star: 825 days. 34% have no followers.

[strong]    Accounts starring in lockstep
            45% of 58 sampled stargazers (26) each starred at least 5 of the same other
            repos within 15 days of at least 3 other sampled stargazers.
            The repos they star together have a median of 98,000 stars, far more than this
            repo's 3,758. Accounts starring one small repo alongside much bigger ones is a
            pattern consistent with inorganic stars. Accounts can star any repo without its
            owner's involvement.

[moderate]  Star bursts over time
            Busiest 2 days: 3,100 stars (2026-09-06 to 2026-09-07). Busiest 7 days: 3,133
            stars, 72% of all star events.
            2026-09-06 to 2026-09-07: 3,100 stars in 2 days, 71% of all star events, against
            a usual 6 a day. New issue authors that month: 1, new PR authors: 1 (typical
            month: 1 and 1).
            Issue and PR activity did not rise with it. A burst alone is consistent with a
            launch (for example a Hacker News front page) or with purchased stars; it is
            evidence only alongside the account checks.

[ok]        Stars that disappeared
            GitHub counts 3,758 stars; the public event stream recorded 4,368 star events,
            so at least 610 (14%) are gone.
            ...

[weak]      Forks and watchers per star
            3,758 stars, 61 forks (1.6 per 100 stars), 9 watchers, 2 open issues and PRs.
            Among 100 repos with a similar star count in TypeScript, the median is 9.5 forks
            per 100 stars; this repo has fewer forks per star than all of them.
            ...

[ok]        What else happened while the stars arrived
            In the last 9 days of public events: 240 stars, 3 forks, 0 issues opened, 0 PRs
            opened, 12 pushes.

Method
  Sample: 60 of the 240 stars in GitHub's public event feed for this repo ...
```

*Illustrative output. The repo, the accounts and every number are made up, and
it was produced by the real checks and formatter from a synthetic fixture (run
`node examples/sample-report.mjs`, or `node examples/sample-report.mjs quiet`
for a repo with nothing to report). This project does not publish assessments
of real repos.*

## Why

Stars are the number people use to pick a library, and they are cheap to buy.
A 2026 study found about six million suspected fake stars on GitHub, many of
them on repos pushing malware or spam. Picking a dependency, an MCP server or a
GitHub Action by star count means trusting a number anyone can inflate.

Most star checkers either give you a single score with nothing behind it, or
they rely on GitHub's stargazer list, which GitHub has stopped serving (the
REST endpoint answers 404 and the GraphQL connection comes back empty). This
tool works with what is still public, says exactly what it sampled, and shows
every number it used, so you can disagree with its reading and still use the
facts.

## What it checks

| Check | Data | What raises it |
|---|---|---|
| Who starred recently | Up to 60 stargazers from the repo's public event feed, with their profiles | A high share of accounts that starred within 30 days of being created and have at most 3 followers and 2 repos, or that were deleted after starring |
| Accounts starring in lockstep | The last 100 stars of each sampled account | Groups of sampled accounts that starred at least 5 of the same other repos within 15 days of each other |
| Star bursts over time | Daily star counts from GH Archive (via OSS Insight), plus monthly new issue and PR authors | A spike that holds 5% or more of all stars, or a week holding a quarter of them, without a matching rise in people filing issues and PRs |
| Stars that disappeared | GitHub's current count vs star events recorded in GH Archive | Losing a quarter or more of recorded stars (GitHub removes stars when it removes accounts) |
| Forks and watchers per star | GitHub search for repos with a similar star count and the same language | Forks per star in the bottom 5% of those peers |
| What else happened | The same event feed | 30 or more stars with no forks, issues or PRs at all |

Each check reports `strong`, `moderate`, `weak`, `ok` (`none` in JSON) or `n/a`, always with the
sentences and numbers behind it. They are combined like this:

- **Account-level evidence carries the weight.** STRONG SIGNALS needs a strong
  result from "who starred" or "lockstep" and support from other checks.
- **Bursts, ratios and removals can support a finding but never make it
  alone.** A burst with clean account checks is reported as consistent with a
  launch.
- **Popular repos get extra care.** Accounts that sell stars also star famous
  repos so they look normal. When the sampled feed covers under 2% of a big
  repo's stars, the account findings are capped at weak, and lockstep among
  accounts whose other stars are equally famous repos is labeled as cover
  traffic rather than pinned on the repo.

The low-activity and lockstep ideas follow He et al., *Six Million (Suspected)
Fake Stars on GitHub: A Growing Spiral of Popularity Contests, Spam, and
Malware*, ICSE 2026 ([doi:10.1145/3744916.3764531](https://doi.org/10.1145/3744916.3764531),
code at [hehao98/StarScout](https://github.com/hehao98/StarScout), Apache-2.0).
StarScout scans all of GH Archive on BigQuery; this is an independent, sampled
re-implementation for checking one repo at a time from a laptop or CI, and it
uses none of their code.

## Use it

```bash
npx fake-star-check owner/repo
npx fake-star-check owner/repo another/repo --json
npx fake-star-check --package package.json          # the GitHub repos behind your npm dependencies
npx fake-star-check --file repos.txt --fail-on strong
```

| Option | |
|---|---|
| `--json` | Machine-readable report |
| `--markdown` | Markdown (what the Action writes to the job summary) |
| `--sample 60` | How many recent stargazers to profile (10 to 100) |
| `--package <file>` / `--dev` | Check a package.json's dependencies (and devDependencies) |
| `--file <file>` | One owner/repo or GitHub URL per line, `#` comments allowed |
| `--no-lockstep` | Skip reading stargazers' other stars (about 1 request per stargazer) |
| `--no-history` / `--no-peers` | Skip OSS Insight history / the peer comparison |
| `--fail-on weak\|some\|strong` | Exit 3 if any repo reaches that assessment |
| `--json-out <file>` / `--markdown-out <file>` | Also write the report to a file |
| `--no-cache` | Skip the response cache (`~/.cache/fake-star-check`, 6 hours) |

**Auth.** It reads `GITHUB_TOKEN` or `GH_TOKEN`, and falls back to
`gh auth token` if the GitHub CLI is logged in. Everything it reads is public,
so a token with no scopes at all is enough, and is the better choice: the token
from `gh auth token` is usually broadly scoped (repo, org, workflow), and this
tool needs none of that. A fine-grained token with public read-only access, or
a classic token with every scope unchecked, works. The token is sent in a
request header to api.github.com only (never to OSS Insight or npm), never put
in a URL, and scrubbed from error messages.

**Cache.** Responses are cached as JSON files in `~/.cache/fake-star-check`
(or `$XDG_CACHE_HOME/fake-star-check`) for 6 hours. Files are readable only by
you (0600 in a 0700 directory), the token is never written to them, and GitHub
entries are keyed by a short hash of the token, so data fetched with one token
is not served to another. Use `--no-cache` to skip it, or delete the folder.

**Repo names that look like options.** Put repos after `--` to have everything
treated as a repo name: `fake-star-check --json -- owner/repo`. The Action does
this for its `repos` input.

**Cost.** About 70 GitHub requests per repo with the default sample (1 repo
lookup, up to 3 event pages, 3 GraphQL calls, up to 60 star lists, 1 search),
plus 3 or more OSS Insight calls. It does not grow with the repo's star count,
so a repo with 300,000 stars costs the same as one with 300. With a personal
token (5,000 requests an hour) that is roughly 70 repos an hour.

## GitHub Action

Vet the repos behind your dependencies on a schedule and on demand. The
evidence goes to the job summary.

```yaml
name: star-check
on:
  workflow_dispatch:
  schedule:
    - cron: '17 6 * * 1'
permissions:
  contents: read
jobs:
  check:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: GroMarketing/fake-star-check@v0
        with:
          package-json: package.json
          # repos: owner/repo another/repo
          # fail-on: strong
```

Inputs: `repos`, `repos-file`, `package-json`, `include-dev`, `sample`,
`lockstep`, `fail-on`, `token` (defaults to the workflow token). Output:
`report`, the path to the JSON report. The workflow token allows about 1,000
requests an hour per repository, so for long dependency lists set
`lockstep: false` or pass a personal token. A full example is in
[`examples/workflow.yml`](examples/workflow.yml). GitHub's scheduler can skip
or delay runs, which is why the example also has `workflow_dispatch`.

## MCP server and Claude Code plugin

```bash
claude mcp add fake-star-check -- npx -y fake-star-check mcp
```

For Cursor, Claude Desktop and others:

```json
{ "mcpServers": { "fake-star-check": { "command": "npx", "args": ["-y", "fake-star-check", "mcp"] } } }
```

It exposes one read-only tool, `check_repo_stars` (up to 10 repos per call).
As a Claude Code plugin:

```
/plugin marketplace add GroMarketing/fake-star-check
/plugin install fake-star-check@fake-star-check
```

The plugin adds a `fake-star-check` skill that tells the agent to report the
evidence and caveats rather than the label, and to treat a burst on its own as
consistent with a launch.

## Library

```js
import { checkRepo, text } from 'fake-star-check';

const report = await checkRepo('owner/repo', { token: process.env.GITHUB_TOKEN });
console.log(report.assessment.level, report.checks.map((c) => [c.id, c.level]));
console.log(text(report));
```

The individual checks (`profileCheck`, `lockstepCheck`, `burstCheck`,
`removalCheck`, `ratioCheck`, `activityCheck`) are pure functions, so you can
run them on data you collected another way.

## Limits and false positives

Read these before you act on a result.

- **It cannot see who paid.** Nobody outside GitHub and the seller can. A repo
  can collect fake stars it never asked for: sellers star unrelated repos so
  their accounts look real, and competitors can buy stars for someone else.
  Treat a finding as a reason to look closer, not as an accusation.
- **The account sample is recent only.** GitHub's event feed holds at most 300
  events and 90 days. For a busy repo that can be a few days of stars. Stars
  bought a year ago are invisible to the account checks; only the burst and
  removal checks can see them.
- **Launches look like bursts.** A Hacker News front page, a viral post or a
  conference talk produces the same spike as a purchase. Without account-level
  evidence, a burst is reported as consistent with either.
- **New accounts are not fake by default.** Students, people who just signed
  up to follow one project, and corporate accounts can be new and empty. The
  account check only means something when the share is high.
- **Low forks per star is normal for some repos**, such as awesome lists,
  documentation, design assets and tools installed from a package registry.
- **The history data is incomplete.** OSS Insight builds it from GH Archive and
  marks its counts as lower bounds since May 2025 (severely degraded since May
  2026) because of changes to GitHub's public event feed. Recent bursts can be
  understated or missed, and the tool says so in the report when this applies.
- **"Hidden" accounts are ambiguous.** GitHub's GraphQL API refuses some
  accounts that its REST API still serves. The tool reports them but does not
  count them as evidence, because GitHub does not document why.
- **Thresholds are judgment calls.** They are in `src/signals.mjs` (`DEFAULTS`)
  and in every JSON report under `method.thresholds`. They were sanity-checked
  against a handful of repos, not tuned on a labeled dataset.

## License

MIT
