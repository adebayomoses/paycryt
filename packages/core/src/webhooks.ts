import { hmacSha256Hex, safeEqual, canonicalJson } from './hash.js';
import type { FetchLike } from './fiat/types.js';

/** Stripe-style signature header: `t=<unix seconds>,v1=<hex hmac of "t.body">`. */
export function signWebhook(secret: string, body: string, timestampSec = Math.floor(Date.now() / 1000)): string {
  return `t=${timestampSec},v1=${hmacSha256Hex(secret, `${timestampSec}.${body}`)}`;
}

/**
 * Verify a signature header. Rejects tampered bodies and, by default, deliveries older than 5 minutes (replay protection).
 *
 * `secret` may be an array so a receiver can rotate secrets without downtime: accept both the old and the new one
 * while senders switch over. The header may also carry several `v1=` values (one per active secret on the sender
 * side); any one matching is enough. Malformed headers return `false`, never throw.
 */
export function verifyWebhook(
  secret: string | string[],
  body: string,
  header: string,
  opts: { toleranceSec?: number; nowSec?: number } = {},
): boolean {
  if (typeof header !== 'string') return false;
  let t: string | undefined;
  const signatures: string[] = [];
  for (const part of header.split(',')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    const key = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (key === 't' && t === undefined) t = value;
    else if (key === 'v1' && value) signatures.push(value);
  }
  if (t === undefined || !/^\d{1,15}$/.test(t) || signatures.length === 0) return false;
  const ts = Number(t);
  const now = opts.nowSec ?? Math.floor(Date.now() / 1000);
  if (Math.abs(now - ts) > (opts.toleranceSec ?? 300)) return false;
  const secrets = (Array.isArray(secret) ? secret : [secret]).filter((x) => x.length > 0);
  // Compare against every candidate without short-circuiting, so timing doesn't reveal which one matched.
  let matched = false;
  for (const sec of secrets) {
    const expected = hmacSha256Hex(sec, `${t}.${body}`);
    for (const sig of signatures) if (safeEqual(expected, sig)) matched = true;
  }
  return matched;
}

export interface DeliveryAttempt {
  eventId: string;
  attempt: number;
  ok: boolean;
  status?: number;
  error?: string;
  at: number;
}

export interface WebhookDispatcherOptions {
  url: string;
  secret: string;
  fetch: FetchLike;
  /** Delays between retries. Default: 1s, 5s, 30s, 5min, 30min. */
  backoffMs?: number[];
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  /** Abort a delivery attempt that takes longer than this. Default 10s, so one hung endpoint can't stall retries forever. */
  timeoutMs?: number;
}

/** Delivers signed events with retries. Keeps a delivery log you can show in a UI or replay from. */
export class WebhookDispatcher {
  readonly log: DeliveryAttempt[] = [];
  private readonly events = new Map<string, { id: string; body: string }>();

  constructor(private readonly o: WebhookDispatcherOptions) {}

  async send(event: { id: string; [k: string]: unknown }): Promise<boolean> {
    const body = canonicalJson(event);
    this.events.set(event.id, { id: event.id, body });
    return this.deliver(event.id);
  }

  /** Re-deliver a stored event (manual replay). The same event id is sent so receivers can de-duplicate. */
  async replay(eventId: string): Promise<boolean> {
    if (!this.events.has(eventId)) throw new Error(`Unknown event ${eventId}`);
    return this.deliver(eventId);
  }

  private async deliver(eventId: string): Promise<boolean> {
    const { body } = this.events.get(eventId)!;
    const backoff = this.o.backoffMs ?? [1_000, 5_000, 30_000, 300_000, 1_800_000];
    const sleep = this.o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
    const now = this.o.now ?? Date.now;
    const timeoutMs = this.o.timeoutMs ?? 10_000;
    for (let attempt = 1; attempt <= backoff.length + 1; attempt++) {
      try {
        const res = await this.o.fetch(this.o.url, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'paycryt-signature': signWebhook(this.o.secret, body, Math.floor(now() / 1000)),
            'paycryt-event-id': eventId,
          },
          body,
          // Never follow redirects: a 3xx from a merchant endpoint could otherwise bounce the signed request to an
          // internal address. A redirect counts as a failed attempt and is retried like any other non-2xx.
          redirect: 'manual',
          signal: AbortSignal.timeout(timeoutMs),
        });
        this.log.push({ eventId, attempt, ok: res.ok, status: res.status, at: now() });
        if (res.ok) return true;
      } catch (err) {
        this.log.push({ eventId, attempt, ok: false, error: err instanceof Error ? err.message : String(err), at: now() });
      }
      const delay = backoff[attempt - 1];
      if (delay === undefined) break;
      await sleep(delay);
    }
    return false;
  }
}
