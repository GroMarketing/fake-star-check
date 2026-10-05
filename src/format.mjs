/** Text and Markdown renderings of a report from checkRepo(). Both always carry every caveat. */
import { CAVEATS } from './signals.mjs';

const fmt = (n) => (n == null ? '?' : Number(n).toLocaleString('en-US'));

function wrap(text, width, indent) {
  const words = String(text).split(/\s+/).filter(Boolean);
  const lines = [];
  let line = '';
  for (const w of words) {
    if (line && line.length + 1 + w.length > width) {
      lines.push(line);
      line = w;
    } else line = line ? `${line} ${w}` : w;
  }
  if (line) lines.push(line);
  return lines.map((l, i) => (i ? indent : '') + l).join('\n');
}

const TAG = { strong: '[strong]', moderate: '[moderate]', weak: '[weak]', none: '[ok]', 'n/a': '[n/a]' };

export function text(report, { width = 92 } = {}) {
  const r = report;
  const out = [];
  const meta = [`${fmt(r.stars)} stars`, `${fmt(r.forks)} forks`, r.watchers != null ? `${fmt(r.watchers)} watchers` : null, r.language, r.createdAt ? `created ${r.createdAt.slice(0, 10)}` : null].filter(Boolean);
  out.push(r.repo);
  out.push(meta.join(', '));
  out.push('');
  out.push(`Assessment: ${r.assessment.label} (${r.assessment.raised} of ${r.assessment.counted} checks raised something)`);
  out.push(wrap(r.assessment.summary, width, ''));
  out.push('');
  const pad = 12;
  for (const c of r.checks) {
    out.push(`${TAG[c.level].padEnd(pad)}${c.title}`);
    for (const e of c.evidence) out.push(' '.repeat(pad) + wrap(e, width - pad, ' '.repeat(pad)));
    out.push('');
  }
  const s = r.method.sample;
  out.push('Method');
  const sampleLine = s.recentStarsInFeed
    ? `Sample: ${fmt(s.used)} of the ${fmt(s.recentStarsInFeed)} stars in GitHub's public event feed for this repo (${s.feedFrom?.slice(0, 10)} to ${s.feedTo?.slice(0, 10)}), spread evenly across it.`
    : 'Sample: GitHub\'s public event feed had no recent stars for this repo.';
  out.push('  ' + wrap(sampleLine, width - 2, '  '));
  out.push('  ' + wrap(`Star history: daily star events from GH Archive via OSS Insight. Reference: ${r.method.reference}.`, width - 2, '  '));
  for (const n of r.notes || []) out.push('  ' + wrap(`Note: ${n}`, width - 2, '  '));
  out.push('');
  for (const c of r.caveats || CAVEATS) out.push(wrap(c, width, ''));
  return out.join('\n');
}

const mdEscape = (s) => String(s).replace(/\|/g, '\\|');

/** One Markdown document for one or more reports (used for the Action's job summary). */
export function markdown(reports, { title = 'Star check' } = {}) {
  const out = [`## ${title}`, '', '| Repo | Stars | Assessment | Checks raised |', '|---|---:|---|---:|'];
  for (const r of reports) {
    if (r.error) out.push(`| ${mdEscape(r.repo)} | | error: ${mdEscape(r.error)} | |`);
    else out.push(`| ${mdEscape(r.repo)} | ${fmt(r.stars)} | ${r.assessment.label} | ${r.assessment.raised} of ${r.assessment.counted} |`);
  }
  out.push('');
  for (const r of reports) {
    if (r.error) continue;
    out.push(`<details><summary><b>${mdEscape(r.repo)}</b>: ${r.assessment.label}</summary>`, '', r.assessment.summary, '');
    for (const c of r.checks) {
      out.push(`**${c.title}** (${c.level})`, '');
      for (const e of c.evidence) out.push(`- ${e}`);
      out.push('');
    }
    out.push(`Sample: ${r.method.sample.used} recent stargazers from GitHub's public event feed.`, '', '</details>', '');
  }
  for (const c of reports.find((r) => r.caveats)?.caveats || CAVEATS) out.push(`_${c}_`, '');
  return out.join('\n');
}
