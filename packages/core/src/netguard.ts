/**
 * Literal-address SSRF guard for user-supplied URLs (e.g. merchant webhook endpoints).
 *
 * This checks the URL's *host as written*: `localhost`, internal-looking names, and IPv4/IPv6 literals in private,
 * loopback, link-local, carrier-grade-NAT, multicast or reserved ranges. The WHATWG URL parser already normalises
 * tricks like `http://2130706433/` or `http://0x7f.1/` to `127.0.0.1`, so pass the parsed `URL#hostname`.
 *
 * It does NOT resolve DNS. A public-looking name that resolves to a private address (or is rebound after this check)
 * still gets through, so for untrusted callers also enforce egress rules at the network layer.
 */

function ipv4Octets(host: string): number[] | undefined {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!m) return undefined;
  const o = m.slice(1).map(Number);
  return o.every((n) => n <= 255) ? o : undefined;
}

function isPrivateIpv4([a, b, c]: number[]): boolean {
  return (
    a === 0 || // "this" network
    a === 10 ||
    a === 127 ||
    (a === 100 && b! >= 64 && b! <= 127) || // carrier-grade NAT
    (a === 169 && b === 254) || // link-local, includes cloud metadata 169.254.169.254
    (a === 172 && b! >= 16 && b! <= 31) ||
    (a === 192 && b === 0 && c === 0) || // IETF protocol assignments
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) || // benchmarking
    a! >= 224 // multicast, reserved, broadcast
  );
}

function ipv6Groups(host: string): number[] | undefined {
  // Expand "::" and an optional trailing dotted IPv4 into 8 sixteen-bit groups.
  let h = host;
  const v4tail = /(\d{1,3}(?:\.\d{1,3}){3})$/.exec(h);
  if (v4tail) {
    const o = ipv4Octets(v4tail[1]!);
    if (!o) return undefined;
    h = h.slice(0, -v4tail[1]!.length) + ((o[0]! << 8) | o[1]!).toString(16) + ':' + ((o[2]! << 8) | o[3]!).toString(16);
  }
  const halves = h.split('::');
  if (halves.length > 2) return undefined;
  const parse = (s: string) => (s === '' ? [] : s.split(':'));
  const head = parse(halves[0]!);
  const tail = halves.length === 2 ? parse(halves[1]!) : [];
  const fill = 8 - head.length - tail.length;
  if ((halves.length === 1 && fill !== 0) || fill < 0) return undefined;
  const all = [...head, ...Array<string>(halves.length === 2 ? fill : 0).fill('0'), ...tail];
  if (all.length !== 8 || !all.every((g) => /^[0-9a-f]{1,4}$/i.test(g))) return undefined;
  return all.map((g) => parseInt(g, 16));
}

function isPrivateIpv6(g: number[]): boolean {
  const [g0, g1, g2, g3, g4, g5, g6, g7] = g as [number, number, number, number, number, number, number, number];
  const allZeroUpTo = (n: number) => g.slice(0, n).every((x) => x === 0);
  if (allZeroUpTo(7) && (g7 === 0 || g7 === 1)) return true; // :: and ::1
  if (allZeroUpTo(5) && g5 === 0xffff) return isPrivateIpv4([g6 >> 8, g6 & 255, g7 >> 8, g7 & 255]); // ::ffff:a.b.c.d
  if (allZeroUpTo(4) && g4 === 0xffff && g5 === 0) return isPrivateIpv4([g6 >> 8, g6 & 255, g7 >> 8, g7 & 255]); // ::ffff:0:a.b.c.d
  if ((g0 & 0xfe00) === 0xfc00) return true; // fc00::/7 unique local
  if ((g0 & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
  if ((g0 & 0xff00) === 0xff00) return true; // ff00::/8 multicast
  if (g0 === 0x64 && g1 === 0xff9b && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0) return isPrivateIpv4([g6 >> 8, g6 & 255, g7 >> 8, g7 & 255]); // NAT64
  return false;
}

/** True when `hostname` (as in `new URL(x).hostname`) is localhost, an internal-looking name, or a private/reserved IP literal. */
export function isPrivateHost(hostname: string): boolean {
  let h = hostname.trim().toLowerCase();
  if (h.startsWith('[') && h.endsWith(']')) h = h.slice(1, -1);
  if (h.endsWith('.')) h = h.slice(0, -1);
  if (!h) return true;
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.internal') || h.endsWith('.lan') || h.endsWith('.home.arpa')) return true;
  const v4 = ipv4Octets(h);
  if (v4) return isPrivateIpv4(v4);
  if (h.includes(':')) {
    const g = ipv6Groups(h);
    return g ? isPrivateIpv6(g) : true; // an address we can't parse is refused
  }
  return false;
}

/**
 * Throws if `rawUrl` isn't an http(s) URL pointing at a public-looking host. Use before accepting a URL that the
 * server will later call. Returns the parsed URL.
 */
export function assertPublicHttpUrl(rawUrl: string, opts: { requireHttps?: boolean } = {}): URL {
  let u: URL;
  try {
    u = new URL(rawUrl);
  } catch {
    throw new Error('must be a valid URL');
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new Error('must be http(s)');
  if (opts.requireHttps && u.protocol !== 'https:') throw new Error('must use https');
  if (u.username || u.password) throw new Error('must not contain credentials');
  if (isPrivateHost(u.hostname)) throw new Error('must not point at a private, loopback or internal address');
  return u;
}
