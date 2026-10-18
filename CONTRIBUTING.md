# Contributing

Thanks for helping. Paycryt moves money, so we optimise for correctness and reviewability over speed.

## Find something to work on

Browse the [issues](https://github.com/adebayomoses/paycryt/issues):

- [`good first issue`](https://github.com/adebayomoses/paycryt/labels/good%20first%20issue): small, well-scoped, with pointers to the files involved. Start here.
- [`help wanted`](https://github.com/adebayomoses/paycryt/labels/help%20wanted): bigger pieces the maintainer would love a hand with.
- [`advanced`](https://github.com/adebayomoses/paycryt/labels/advanced): needs real design (and usually a security review). Please talk to us in the issue before writing code.
- Labels like `area: pos` and `area: adapters` show which part of the project an issue touches.

**To claim an issue, comment on it.** That stops two people building the same thing. If you go quiet for a couple of weeks, we will ask whether you still want it and may hand it on. Questions are welcome in the issue itself.

Have your own idea, or a rail or chain for your market? Open a [feature request](https://github.com/adebayomoses/paycryt/issues/new/choose) first so we can agree on the approach before you invest time. [ROADMAP.md](ROADMAP.md) shows where the project is headed.

## Setup

```bash
git clone https://github.com/adebayomoses/paycryt.git && cd paycryt
npm install
npm run build        # compiles the packages and bundles the POS app
npm test
npm run sandbox      # server + dashboard + POS on http://127.0.0.1:8787 (key: sandbox_key)
```

Node 22.5+ (developed on 24). The SQLite store uses the built-in `node:sqlite`, which older Node versions lack, so the test suite needs 22.5 or newer. Tests run against TypeScript sources via Vitest; `npm run build` produces `dist/` for the packages and `packages/server/ui/pos.js` for the till.

Useful commands:

| | |
|---|---|
| `npm test` | the whole suite (a few hundred tests, about 30 seconds) |
| `npx vitest run packages/core/test/policy.test.ts` | one file |
| `npm run e2e:pos` | drives a real Chrome through the offline POS, killing the server mid-session (needs Chrome or Chromium) |
| `npm run release:check` | what would be published is complete and clean |

## How the repo is laid out

| | |
|---|---|
| `packages/core` | the logic: money, addresses, rates, payment policy, watcher, offline POS engine. No network code. Runs in Node and browsers. |
| `packages/adapters` | the real world: chain watchers, rate sources, Paystack/Flutterwave, stores. Everything takes an injected `fetch`. |
| `packages/server` | the API, the dashboard and POS (`ui/`), and the POS source (`pos/`). |
| `docs/` | one page per feature. If you change what a user can see, change its page. |

## Ground rules

- **No floating-point money.** Use `bigint` minor units and the helpers in `amount.ts`. Round in the merchant's favour when pricing.
- **Every behaviour change needs a test**, ideally one that fails without the change. Policy and rate logic are pure functions: test them directly with the controllable clock in `packages/core/test/helpers.ts`. A good habit: after your test passes, break your own fix on purpose and check the test fails. Several real bugs here were found that way.
- **Fail closed.** If a price, an address check or a signature cannot be verified, refuse (a 503, a rejection) rather than guess. Never hand a customer an address nobody is watching.
- **Adapters take an injected `fetch`** and are tested with mocked responses. Never commit real keys; a test key pasted in a PR is a leaked key.
- **Decisions are data.** Core code returns actions/events; it does not call payment providers implicitly.
- **The browser code is held to a strict CSP.** In `packages/server/ui` and `packages/server/pos`: no `innerHTML`, no inline styles or scripts, no third-party scripts, and nothing secret in `localStorage`. Tests scan for these.
- Security-sensitive changes (address derivation, signature checks, sync validation) need a note in the PR on the threat they address. **Report vulnerabilities privately** (see [SECURITY.md](SECURITY.md)); do not open a public issue.

## Adding a rail or a chain

- Fiat rail: implement `SettlementProvider` / `CollectionProvider`; see [docs/adapters.md](docs/adapters.md). Say honestly in the docs what you verified against the real provider and what you could not.
- Chain: implement `ChainAdapter` (and `AddressDeriver` if it has its own address format), including `supportsAsset` so the server never offers an asset your watcher cannot see. Then add a scenario test against `FakeChain` to prove the behaviour matches.

## Pull requests

Small, focused PRs, one concern each. The PR template asks for the real output of `npm test`; please fill it in. Maintainers squash-merge, so you do not need to tidy your commit history, but do give the PR a clear title because it becomes the commit message. CI must be green (Node 22 and 24), and a first-time contributor's CI needs a maintainer to click "Approve and run workflows", so please be patient.

We would rather review a draft early than a finished surprise. Open it as a draft and say what you want feedback on.
