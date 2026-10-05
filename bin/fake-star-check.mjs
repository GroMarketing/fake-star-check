#!/usr/bin/env node
import fs from 'node:fs';
import { checkRepo } from '../src/check.mjs';
import { text, markdown } from '../src/format.mjs';
import { reposForPackage } from '../src/npm.mjs';
import { fileCache, noCache } from '../src/cache.mjs';
import { createGitHub, resolveToken } from '../src/github.mjs';
import { redact } from '../src/http.mjs';

const HELP = `fake-star-check: look for signs of fake GitHub stars, with the evidence behind each one.
Read-only. A heuristic, not proof.

  fake-star-check <owner/repo>... [options]
  fake-star-check --file repos.txt            one owner/repo (or GitHub URL) per line, # comments ok
  fake-star-check --package package.json      check the GitHub repos behind your npm dependencies
  fake-star-check mcp                         run as an MCP server (stdio)
  fake-star-check [options] -- <owner/repo>...  everything after -- is a repo, never an option

Options:
  --json                 machine-readable output
  --markdown             Markdown (what the GitHub Action writes to the job summary)
  --sample 60            how many recent stargazers to profile (10-100)
  --dev                  with --package, include devDependencies
  --no-lockstep          skip reading stargazers' other stars (saves ~1 request per stargazer)
  --no-history           skip OSS Insight star history
  --no-peers             skip the comparison with similar repos
  --no-cache             do not read or write the response cache (~/.cache/fake-star-check, 6 hours)
  --json-out <file>      also write the JSON report to a file
  --markdown-out <file>  also append the Markdown report to a file (e.g. $GITHUB_STEP_SUMMARY)
  --fail-on <level>      exit 3 if any repo's assessment is at least: weak | some | strong
  --quiet                no progress lines on stderr

Auth: GITHUB_TOKEN or GH_TOKEN from the environment, else \`gh auth token\`.
Any token works; public data needs no scopes. It is sent in a header and never printed.`;

const argv = process.argv.slice(2);
const VALUED = new Set(['file', 'package', 'sample', 'fail-on', 'json-out', 'markdown-out']);
const opt = {};
const pos = [];
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--') {
    // End of options: everything after this is a repo name, even if it starts with "--".
    pos.push(...argv.slice(i + 1));
    break;
  }
  if (a.startsWith('--') && VALUED.has(a.slice(2))) opt[a.slice(2)] = argv[++i];
  else if (a.startsWith('--')) opt[a.slice(2)] = true;
  else pos.push(a);
}

const ORDER = { none: 0, weak: 1, some: 2, strong: 3 };

async function main() {
  if (pos[0] === 'mcp' && !argv.includes('--')) return (await import('../src/mcp.mjs')).startServer();
  if (opt.help || opt.h || pos[0] === 'help' || (!pos.length && !opt.file && !opt.package)) {
    console.log(HELP);
    process.exit(opt.help || opt.h || pos[0] === 'help' ? 0 : 2);
  }
  if (opt['fail-on'] && !(opt['fail-on'] in ORDER)) {
    console.error('--fail-on takes weak, some or strong');
    process.exit(2);
  }
  const sample = Math.min(100, Math.max(10, Number(opt.sample || 60)));
  const cache = opt['no-cache'] ? noCache : fileCache();
  const log = opt.quiet ? () => {} : (m) => process.stderr.write(`  ${m}\n`);

  const repos = [...pos];
  if (opt.file) {
    for (const line of fs.readFileSync(opt.file, 'utf8').split(/\r?\n/)) {
      const s = line.replace(/#.*/, '').trim();
      if (s) repos.push(s);
    }
  }
  if (opt.package) {
    const pkg = JSON.parse(fs.readFileSync(opt.package, 'utf8'));
    const deps = await reposForPackage(pkg, { dev: Boolean(opt.dev), cache });
    for (const d of deps) {
      if (d.repo) repos.push(d.repo);
      else log(`${d.name}: no GitHub repository in its npm metadata, skipped`);
    }
  }
  const unique = [...new Set(repos.map((r) => r.replace(/^https?:\/\/github\.com\//i, '').replace(/\.git$/, '').replace(/\/+$/, '').toLowerCase()))];
  if (!unique.length) {
    console.error('no repos to check');
    process.exit(2);
  }

  const github = createGitHub({ token: resolveToken(), cache });
  const reports = [];
  for (const r of unique) {
    try {
      reports.push(await checkRepo(r, { github, cache, sample, lockstep: !opt['no-lockstep'], history: !opt['no-history'], peers: !opt['no-peers'], onProgress: log }));
    } catch (e) {
      reports.push({ repo: r, error: redact(e.message || String(e)) });
    }
  }

  if (opt.json) console.log(JSON.stringify(reports.length === 1 ? reports[0] : reports, null, 2));
  else if (opt.markdown) console.log(markdown(reports));
  else {
    console.log(reports.map((r) => (r.error ? `${r.repo}\nerror: ${r.error}` : text(r))).join('\n\n' + '-'.repeat(60) + '\n\n'));
  }

  if (opt['json-out']) fs.writeFileSync(opt['json-out'], JSON.stringify(reports, null, 2));
  if (opt['markdown-out']) fs.appendFileSync(opt['markdown-out'], markdown(reports) + '\n');

  if (reports.some((r) => r.error)) process.exitCode = 1;
  const failOn = opt['fail-on'];
  if (failOn && reports.some((r) => !r.error && ORDER[r.assessment.level] >= ORDER[failOn])) process.exitCode = 3;
}

main().catch((e) => {
  console.error(redact(e.message || e));
  process.exit(1);
});
