import { readdir } from 'node:fs/promises';
import path from 'node:path';

import { auditExpectationMismatches, auditGatePassed, auditXml14Instance, summarizeAuditResults } from './xml14-suite-audit.js';

const xsdPath = process.argv[2] ?? process.env['ASAM_OPENSCENARIO_14_XSD'];
if (!xsdPath) throw new Error('Usage: tsx audit-xml14-suite.ts /path/to/official/OpenSCENARIO.xsd');

const suiteRoot = path.resolve('examples/edge-cases');
const entries = (await readdir(suiteRoot, { withFileTypes: true }))
  .filter((entry) => entry.isDirectory() && /^\d{2}-/u.test(entry.name))
  .map((entry) => path.join(suiteRoot, entry.name, 'scenario.instance.json'))
  .sort();
if (entries.length === 0) throw new Error(`No curated edge-case instances found in ${suiteRoot}`);

const results = await Promise.all(entries.map((file) => auditXml14Instance(file, xsdPath!)));
const counts = summarizeAuditResults(results);
const expectationMismatches = auditExpectationMismatches(results);
const report = {
  schema: 'simforge-oss.openscenario-1.4-suite-audit/v2',
  suite: 'examples/edge-cases/*/scenario.instance.json',
  topologySource: 'production-dev-assets',
  supportBaseline: 'xml14-curated-suite/v2',
  officialXsd: path.resolve(xsdPath),
  counts,
  gatePassed: auditGatePassed(counts),
  expectationMismatches,
  results,
};
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
if (!report.gatePassed) process.exitCode = 1;
