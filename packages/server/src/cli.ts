#!/usr/bin/env node
import { PaycrytServer } from './app.js';

const port = Number(process.env.PORT ?? 8787);
const apiKey = process.env.PAYCRYT_API_KEY ?? 'sandbox_key';
const sandbox = process.env.PAYCRYT_SANDBOX !== 'false';

if (!sandbox && apiKey === 'sandbox_key') {
  console.error('Refusing to start outside sandbox mode with the default API key. Set PAYCRYT_API_KEY.');
  process.exit(1);
}

const server = new PaycrytServer({
  apiKey,
  sandbox,
  webhookUrl: process.env.PAYCRYT_WEBHOOK_URL,
  webhookSecret: process.env.PAYCRYT_WEBHOOK_SECRET,
  spreadBps: process.env.PAYCRYT_SPREAD_BPS ? Number(process.env.PAYCRYT_SPREAD_BPS) : undefined,
});

const host = process.env.HOST ?? '127.0.0.1';
const actual = await server.listen(port, host);
console.log(`Paycryt ${sandbox ? 'SANDBOX' : 'server'} listening on http://${host}:${actual}`);
console.log(`  API key:  ${sandbox ? apiKey : '(from PAYCRYT_API_KEY)'}`);
if (sandbox) {
  console.log('  Fake chain, simulated deposits, and mock settlement are enabled. No real money moves.');
  console.log(`\n  Try:  curl -H "Authorization: Bearer ${apiKey}" http://${host}:${actual}/v1/rates/USDT-NGN`);
}
