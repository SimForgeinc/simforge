#!/usr/bin/env node
/**
 * `simforge-extractor` — parse a natural-language episode description
 * into claims.v1 via any OpenAI-compatible endpoint, then optionally grade it
 * against a corpus scenario's engine ground truth.
 *
 * No secrets are baked in: the bearer token is read at runtime from the
 * environment variable named by `--api-key-env`.
 *
 * Examples:
 *   simforge-extractor --endpoint http://localhost:8000/v1 --model qwen2.5-7b-instruct \
 *     --corpus corpus.v1.json --scenario bus-stop-emergence__yale-street__fa9fa19457cf576f \
 *     --description-file desc.txt --grade
 *   echo "The child is occluded..." | simforge-extractor --endpoint ... --model ...
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';

import { claimSetSchema } from '../claims.js';
import type { Corpus } from '../corpus.js';
import { grade } from '../grader.js';
import { extractClaims } from './extract.js';
import { openAiCompatibleCompletion } from './openai-compatible.js';
import { scenarioContextLine } from './prompt.js';

interface Flags {
  readonly endpoint: string;
  readonly model: string;
  readonly apiKeyEnv?: string;
  readonly corpus?: string;
  readonly scenario?: string;
  readonly descriptionFile?: string;
  readonly grade: boolean;
}

function usage(): string {
  return [
    'usage: simforge-extractor --endpoint URL --model NAME [options]',
    '',
    '  --endpoint URL            OpenAI-compatible base URL (…/v1)',
    '  --model NAME              model id',
    '  --api-key-env NAME        env var carrying the bearer token (optional)',
    '  --corpus FILE             corpus JSON for scenario context / grading',
    '  --scenario ID             scenario id in the corpus (id or corpus#id)',
    '  --description-file FILE   NL description (default: stdin)',
    '  --grade                   also grade the parsed claims against engine ground truth',
    '  --help',
  ].join('\n');
}

function parseArgs(argv: readonly string[]): Flags {
  const flags: { endpoint?: string; model?: string; apiKeyEnv?: string; corpus?: string; scenario?: string; descriptionFile?: string; grade?: boolean } = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    switch (a) {
      case '--endpoint': flags.endpoint = argv[++i]; break;
      case '--model': flags.model = argv[++i]; break;
      case '--api-key-env': flags.apiKeyEnv = argv[++i]; break;
      case '--corpus': flags.corpus = argv[++i]; break;
      case '--scenario': flags.scenario = argv[++i]; break;
      case '--description-file': flags.descriptionFile = argv[++i]; break;
      case '--grade': flags.grade = true; break;
      case '--help': case '-h': process.stdout.write(`${usage()}\n`); process.exit(0);
      default: process.stderr.write(`unknown flag: ${a}\n${usage()}\n`); process.exit(1);
    }
  }
  if (!flags.endpoint || !flags.model) {
    process.stderr.write(`--endpoint and --model are required\n${usage()}\n`);
    process.exit(1);
  }
  return { ...flags, endpoint: flags.endpoint, model: flags.model, grade: flags.grade ?? false };
}

async function readDescription(file: string | undefined): Promise<string> {
  if (file) return readFileSync(file, 'utf8');
  return readFileSync(0, 'utf8');
}

async function main(): Promise<number> {
  const flags = parseArgs(process.argv.slice(2));
  const description = (await readDescription(flags.descriptionFile)).trim();
  if (!description) {
    process.stderr.write('empty description\n');
    return 1;
  }

  let scenarioContext = 'no scenario context supplied; use generic actor ids from the description only';
  let scenario = undefined;
  if (flags.corpus && flags.scenario) {
    const corpus = JSON.parse(readFileSync(flags.corpus, 'utf8')) as Corpus;
    const wanted = flags.scenario.includes('#') ? flags.scenario.split('#')[1]! : flags.scenario;
    scenario = corpus.scenarios.find((s) => s.id === wanted);
    if (!scenario) {
      process.stderr.write(`scenario "${wanted}" not in corpus\n`);
      return 1;
    }
    scenarioContext = scenarioContextLine(scenario);
  }

  const completion = openAiCompatibleCompletion({
    baseUrl: flags.endpoint,
    model: flags.model,
    ...(flags.apiKeyEnv ? { apiKeyEnv: flags.apiKeyEnv } : {}),
  });
  const claimSet = await extractClaims(completion, description, { scenarioContext });
  const parsed = claimSetSchema.parse(claimSet);

  if (!flags.grade || !scenario) {
    process.stdout.write(`${JSON.stringify(parsed, null, 2)}\n`);
    return 0;
  }
  const report = grade(scenario, parsed.claims);
  process.stdout.write(
    `${JSON.stringify(
      {
        claimSet: parsed,
        grader: {
          score: report.score,
          causality: report.causality,
          coverage: report.coverage,
          verdicts: report.verdicts,
          uncoveredTruth: report.uncoveredTruth,
        },
      },
      null,
      2,
    )}\n`,
  );
  return 0;
}

const invoked = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (invoked.endsWith('cli.ts') || invoked.endsWith('cli.js')) {
  main()
    .then((code) => process.exit(code))
    .catch((err: unknown) => {
      process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
      process.exit(1);
    });
}
