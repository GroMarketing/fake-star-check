---
name: fake-star-check
description: Check public GitHub repos for signs of fake or purchased stars and report the evidence (new and empty stargazer accounts, accounts starring in lockstep, star bursts, stars that disappeared, forks per star vs similar repos). Use when vetting a dependency, tool, MCP server or library before adopting it, when someone asks "are these stars real" or "is this repo's popularity legit", or when comparing projects by star count.
---

# fake-star-check

Use the `check_repo_stars` MCP tool if connected, otherwise the CLI
(`npx fake-star-check owner/repo`, add `--json` for structured output).

| Need | Tool / command |
|---|---|
| One or a few repos | `check_repo_stars` with `repos: ["owner/repo"]` / `fake-star-check owner/repo` |
| A project's npm dependencies | `fake-star-check --package package.json` |
| A list in a file | `fake-star-check --file repos.txt` |
| Faster, fewer API calls | `lockstep: false` / `--no-lockstep` |

## Read the result honestly

- **It is a heuristic, not proof.** Never turn the label into an accusation.
  Report the evidence lines and the caveats with it.
- **Lead with the evidence, not the label.** "43% of 60 sampled recent
  stargazers made their account within 30 days of starring and have no repos"
  is useful. "STRONG SIGNALS consistent with inorganic stars" on its own is not.
- **Bursts alone mean little.** A Hacker News front page or a viral post
  produces the same spike as a purchase. Say "consistent with a launch or with
  purchased stars" unless account-level checks agree.
- **The account sample is recent only.** GitHub no longer lists stargazers, so
  the tool samples stars from the repo's public event feed (at most 300 events,
  90 days). For a big repo that may be a few days of stars. A clean sample does
  not clear stars bought earlier, and a dirty one on a popular repo may be cover
  traffic: accounts that sell stars also star famous repos to look normal.
- **Low forks per star** is common for lists, docs and design repos.
- Results depend on OSS Insight's GH Archive data, which it marks as lower
  bounds since mid 2025. Pass that caveat on when bursts matter.

## Report

One line per repo: the assessment and the one or two strongest evidence
sentences, then the sample size and window. Do not publish assessments of
other people's repos as findings; share them as questions to look into.
