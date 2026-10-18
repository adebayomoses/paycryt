## What and why

<!-- One paragraph. Link the issue: "Closes #123". -->

## How it was tested

<!-- Paste the real output of `npm test`. "It works" is not a test result. A new behaviour needs a test that FAILS without your change. -->

```
npm run build && npm test
```

## Does it touch money, keys, or what a customer is told to pay?

<!-- Amounts, rates, addresses, signatures, sync validation, auth. If yes: which threat does this address, and what happens if your code is wrong? Say how it fails (it should fail closed). -->

## Checklist

- [ ] `npm run build && npm test` passes locally
- [ ] New or changed behaviour has a test (ideally one that fails without the change)
- [ ] No floating-point money: `bigint` minor units only
- [ ] No keys, mnemonics or secrets in the diff, tests or docs
- [ ] Docs updated if behaviour a user can see changed
- [ ] For UI changes: no `innerHTML`, no inline styles or scripts (the CSP forbids them and a test checks)
