#!/usr/bin/env node
import { SqliteStore } from '@paycryt/adapters';
import type { FetchLike } from '@paycryt/core';
import { PaycrytServer } from './app.js';
import { buildLiveConfig } from './live-config.js';

const fail = (message: string): never => {
  console.error(`Paycryt: ${message}`);
  process.exit(1);
};

const port = Number(process.env.PORT ?? 8787);
const apiKey = process.env.PAYCRYT_API_KEY ?? 'sandbox_key';
const sandbox = process.env.PAYCRYT_SANDBOX !== 'false';
const dbPath = process.env.PAYCRYT_DB_PATH;
const pollIntervalMs = process.env.PAYCRYT_POLL_MS ? Number(process.env.PAYCRYT_POLL_MS) : undefined;
const pollConcurrency = process.env.PAYCRYT_POLL_CONCURRENCY ? Number(process.env.PAYCRYT_POLL_CONCURRENCY) : undefined;

if (!sandbox && apiKey === 'sandbox_key') fail('refusing to start outside sandbox mode with the default API key. Set PAYCRYT_API_KEY.');
if (!sandbox && apiKey.length < 24) fail('PAYCRYT_API_KEY is short for an admin key that can onboard merchants; use at least 24 random characters.');
for (const [name, v] of [['PAYCRYT_POLL_MS', pollIntervalMs], ['PAYCRYT_POLL_CONCURRENCY', pollConcurrency]] as const) {
  if (v !== undefined && (!Number.isInteger(v) || v < 1)) fail(`${name} must be a positive integer`);
}
if (!sandbox && !dbPath && process.env.PAYCRYT_ALLOW_EPHEMERAL !== 'true') {
  fail(
    'live mode needs PAYCRYT_DB_PATH so payments, merchants and wallet indexes survive a restart. Without it, a restart forgets open payments and a customer who pays afterwards is never matched. Set PAYCRYT_ALLOW_EPHEMERAL=true only to experiment.',
  );
}

let live: ReturnType<typeof buildLiveConfig> | undefined;
if (!sandbox) {
  try {
    live = buildLiveConfig(process.env, globalThis.fetch as unknown as FetchLike);
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err));
  }
}

const server = await PaycrytServer.create({
  apiKey,
  sandbox,
  webhookUrl: process.env.PAYCRYT_WEBHOOK_URL,
  webhookSecret: process.env.PAYCRYT_WEBHOOK_SECRET,
  spreadBps: process.env.PAYCRYT_SPREAD_BPS ? Number(process.env.PAYCRYT_SPREAD_BPS) : undefined,
  // Set PAYCRYT_DB_PATH to persist payments, merchants and the rate audit trail across restarts.
  store: dbPath ? new SqliteStore(dbPath) : undefined,
  chains: live?.chains,
  rateProviders: live?.rateProviders,
  minRateSources: live?.minRateSources,
  maxRateDeviationBps: live?.maxRateDeviationBps,
  pollIntervalMs,
  pollConcurrency,
});

const host = process.env.HOST ?? '127.0.0.1';
const actual = await server.listen(port, host);
console.log(`Paycryt ${sandbox ? 'SANDBOX' : 'LIVE'} server listening on http://${host}:${actual}`);
console.log(`  API key:  ${sandbox ? apiKey : '(from PAYCRYT_API_KEY)'}`);
console.log(`  Storage:  ${dbPath ? `SQLite at ${dbPath} (survives restarts)` : 'in-memory (set PAYCRYT_DB_PATH to persist)'}`);
if (sandbox) {
  console.log('  Fake chain, simulated deposits, and mock settlement are enabled. No real money moves.');
  console.log(`\n  Try:  curl -H "Authorization: Bearer ${apiKey}" http://${host}:${actual}/v1/rates/USDT-NGN`);
} else {
  for (const line of live!.summary) console.log(`  ${line.startsWith('WARNING') || line.startsWith('note') ? '! ' : ''}${line}`);
  console.log('  Live: real chains and real prices. Onboard merchants (with wallets) via /v1/admin/merchants; check health at /v1/status.');
}
