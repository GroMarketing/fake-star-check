import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { createRequire } from 'node:module';
import { checkRepo } from './check.mjs';
import { createGitHub, resolveToken } from './github.mjs';
import { fileCache } from './cache.mjs';
import { text } from './format.mjs';
import { redact } from './http.mjs';

const { version } = createRequire(import.meta.url)('../package.json');
const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true };

export async function startServer() {
  const server = new McpServer({ name: 'fake-star-check', version });
  const cache = fileCache();
  let github;

  server.registerTool(
    'check_repo_stars',
    {
      title: 'Check GitHub repos for signs of fake stars',
      description:
        'Looks for signs of fake or purchased stars on public GitHub repos and returns the evidence behind each signal: who starred recently (account age, followers, repos), whether those accounts star the same repos in lockstep, star bursts over time, stars that later disappeared, and forks per star against similar repos. A heuristic, not proof: report the evidence and caveats, never just the label, and do not present it as an accusation.',
      inputSchema: {
        repos: z.array(z.string()).min(1).max(10).describe('owner/repo names or GitHub URLs'),
        sample: z.number().int().min(10).max(100).optional().describe('Recent stargazers to profile (default 60)'),
        lockstep: z.boolean().optional().describe('Read sampled stargazers\' other stars (about 1 request each). Default true.'),
      },
      annotations: READ_ONLY,
    },
    async ({ repos, sample = 60, lockstep = true }) => {
      try {
        github ||= createGitHub({ token: resolveToken(), cache });
        const reports = [];
        for (const r of repos) {
          try {
            reports.push(await checkRepo(r, { github, cache, sample, lockstep }));
          } catch (e) {
            reports.push({ repo: r, error: redact(e.message || String(e)) });
          }
        }
        return {
          content: [{ type: 'text', text: reports.map((r) => (r.error ? `${r.repo}: error: ${r.error}` : text(r))).join('\n\n') }],
          structuredContent: { reports },
        };
      } catch (e) {
        return { content: [{ type: 'text', text: redact(e.message || String(e)) }], isError: true };
      }
    },
  );

  await server.connect(new StdioServerTransport());
}
