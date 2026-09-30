import { afterEach, describe, expect, it } from 'vitest';
import { PaycrytServer } from '@paycryt/server';

const ADMIN = 'admin_key';
let server: PaycrytServer | undefined;

async function start(blockPrivateWebhookUrls?: boolean) {
  server = await PaycrytServer.create({ apiKey: ADMIN, sandbox: true, blockPrivateWebhookUrls });
  return `http://127.0.0.1:${await server.listen(0)}`;
}

async function createMerchant(base: string, webhookUrl: string) {
  const res = await fetch(`${base}/v1/admin/merchants`, {
    method: 'POST',
    headers: { authorization: `Bearer ${ADMIN}`, 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'Ada', webhookUrl }),
  });
  return { status: res.status, body: (await res.json()) as any };
}

afterEach(async () => {
  await server?.close();
  server = undefined;
});

describe('merchant webhookUrl SSRF guard', () => {
  it('is off by default, so local sandbox receivers still work', async () => {
    const base = await start();
    expect((await createMerchant(base, 'http://127.0.0.1:9999/hook')).status).toBe(201);
  });

  it('rejects private, loopback and metadata targets when enabled', async () => {
    const base = await start(true);
    for (const url of ['http://127.0.0.1:9999/hook', 'http://localhost/hook', 'http://169.254.169.254/latest', 'http://[::1]/hook', 'http://10.0.0.8/hook', 'http://2130706433/hook']) {
      const r = await createMerchant(base, url);
      expect(r.status, url).toBe(400);
      expect(r.body.error, url).toMatch(/^webhookUrl must not point at a private/);
    }
  });

  it('still accepts a public https endpoint when enabled', async () => {
    const base = await start(true);
    expect((await createMerchant(base, 'https://hooks.ada.example/paycryt')).status).toBe(201);
  });
});
