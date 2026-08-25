#!/usr/bin/env node
/**
 * simforge-eval-campaign — closed-loop evaluation campaigns over policy_step.
 *
 *   simforge-eval-campaign run    --config <campaign.json>   # run / resume
 *   simforge-eval-campaign rerun  --config <c> --episode <id> # determinism proof
 *   simforge-eval-campaign report --config <campaign.json>   # report.json + report.md
 *
 * `run` is resumable by construction: episodes with a COMPLETE marker are
 * skipped, incomplete episode dirs are wiped and rerun, and the ledger is
 * append-only. Killing the process at any point loses at most the episode
 * that was in flight.
 */

import { resolveCampaign, rerunEpisode, runCampaign, writeReport } from './campaign.js';

interface CliFlags {
  config?: string;
  episode?: string;
}

function parseFlags(argv: readonly string[]): CliFlags {
  const flags: CliFlags = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    const value = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${arg} requires a value`);
      return v;
    };
    switch (arg) {
      case '--config': flags.config = value(); break;
      case '--episode': flags.episode = value(); break;
      default: throw new Error(`unknown flag ${arg}`);
    }
  }
  return flags;
}

function usage(): never {
  process.stderr.write(
    'usage: simforge-eval-campaign <run|rerun|report> --config <campaign.json> [--episode <id>]\n',
  );
  process.exit(2);
}

const [command, ...rest] = process.argv.slice(2);
if (!command) usage();
const flags = parseFlags(rest);
if (!flags.config) usage();

const campaign = await resolveCampaign(flags.config);

switch (command) {
  case 'run': {
    const results = await runCampaign(campaign, (line) => process.stderr.write(`${line}\n`));
    const completed = results.filter((r) => r.status === 'complete').length;
    const skipped = results.length - completed;
    process.stdout.write(
      `${JSON.stringify({ campaignId: campaign.config.campaignId, episodes: results.length, completed, skipped })}\n`,
    );
    break;
  }
  case 'rerun': {
    if (!flags.episode) usage();
    const verdict = await rerunEpisode(campaign, flags.episode);
    process.stdout.write(`${JSON.stringify(verdict, null, 1)}\n`);
    if (!verdict.match) process.exit(1);
    break;
  }
  case 'report': {
    const report = await writeReport(campaign);
    process.stdout.write(`${JSON.stringify(report, null, 1)}\n`);
    break;
  }
  default:
    usage();
}
