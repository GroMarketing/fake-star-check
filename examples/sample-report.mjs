#!/usr/bin/env node
// Prints the README's sample reports from synthetic data (no network, no real repos).
//   node examples/sample-report.mjs [suspicious|quiet] [--json]
import { checkRepo } from '../src/check.mjs';
import { text } from '../src/format.mjs';
import { buildFixture, fixtureFetch } from './sample-fixture.mjs';

const scenario = process.argv.slice(2).find((a) => !a.startsWith('--')) || 'suspicious';
const fx = buildFixture(scenario);
const report = await checkRepo(fx.full, { token: 'fixture-token-not-real', fetchImpl: fixtureFetch(fx), now: new Date(fx.now), retryDelayMs: 0 });
console.log(process.argv.includes('--json') ? JSON.stringify(report, null, 2) : text(report));
