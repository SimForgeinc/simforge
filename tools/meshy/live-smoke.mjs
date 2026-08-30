#!/usr/bin/env node

import { apiRequest } from './generate.mjs';

const apiKey = process.env.MESHY_API_KEY;
if (!apiKey) {
  console.log('Meshy live smoke skipped: MESHY_API_KEY is not set');
  process.exit(0);
}

try {
  const result = await apiRequest(apiKey, 'GET', '/v1/balance');
  if (!Number.isFinite(result.balance) || result.balance < 0) {
    throw new Error('Meshy balance response did not contain a non-negative numeric balance');
  }
  console.log(`Meshy live smoke passed (balance endpoint authenticated; ${result.balance} credits available)`);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
