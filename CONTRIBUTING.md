# Contributing

Thanks for helping. Paycryt moves money, so we optimise for correctness and reviewability over speed.

## Setup

```bash
npm install
npm run build
npm test
```

Node 20+ (developed on 24). Tests run against TypeScript sources via Vitest; `npm run build` produces `dist/` for the packages.

## Ground rules

- **No floating-point money.** Use `bigint` minor units and the helpers in `amount.ts`. Round in the merchant's favour when pricing.
- **Every behaviour change needs a test**, ideally one that fails without the change. Policy and rate logic are pure functions: test them directly with the controllable clock in `packages/core/test/helpers.ts`.
- **Adapters take an injected `fetch`** and are tested with mocked responses. Never commit real keys.
- **Decisions are data.** Core code returns actions/events; it does not call payment providers implicitly.
- Security-sensitive changes (address derivation, signature checks, sync validation) need a note in the PR on the threat they address. Report vulnerabilities privately (see SECURITY.md).

## Adding a rail or a chain

- Fiat rail: implement `SettlementProvider` / `CollectionProvider`; see `docs/adapters.md`.
- Chain: implement `ChainAdapter` (and `AddressDeriver` if it has its own address format), then add a scenario test against `FakeChain` to prove the behaviour matches.

## Pull requests

Small, focused PRs. Describe what changed and why, and list how you tested it.
