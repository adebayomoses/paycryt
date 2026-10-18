# Releasing to npm

For maintainers. Three packages are published in lockstep, always at the same version:

| Package | What |
|---|---|
| `@paycryt/core` | the engine |
| `@paycryt/adapters` | chain watchers, rate sources, fiat rails, stores |
| `@paycryt/server` | the server, dashboard and POS app (`npx @paycryt/server`) |

They publish under the dist-tag **`alpha`**, set in each `package.json` (`publishConfig.tag`), so nobody gets this by accident as `latest`. Users install with `npm install @paycryt/core@alpha`. When you are ready to call a version the default, promote it explicitly (see the end).

## One-time setup (only you can do this)

1. **Create the npm organisation `paycryt`** at <https://www.npmjs.com/org/create> (free for public packages). The `@paycryt/` scope belongs to whoever owns that org. If the name is taken, pick another scope and change `name` in the three `package.json` files (and every `@paycryt/` import) before the first publish. Names cannot be reused after a publish.
2. **Turn on 2FA** for your npm account.
3. **Create a granular access token** (npm account, Access Tokens): permission *Read and write* for the `@paycryt` packages only, short expiry. Add it to the GitHub repository as the secret **`NPM_TOKEN`** (Settings, Secrets and variables, Actions). The token never touches this repo or any chat.

## Before every release

```bash
npm run build
npm test
npm run release:check     # metadata, licences, build outputs, tarball contents
npm run release:smoke     # installs the PACKED packages into an empty project, runs the README examples and the CLI
```

`release:check` also runs automatically as each package's `prepublishOnly`, so even a hand-typed `npm publish` cannot ship a package missing its generated `ui/pos.js`.

Then rehearse the whole pipeline on GitHub without publishing anything: **Actions, Release, Run workflow, leave "dry-run" ticked**. It builds, tests, packs, installs the packages into an empty project and does `npm publish --dry-run` for all three, on GitHub's own runner.

## Cut the release

1. Pick the version. Bump all four `package.json` files (root and the three packages) to the same number, and keep the packages' dependencies on each other in range:
   ```bash
   npm version 0.1.1 --workspaces --include-workspace-root --no-git-tag-version
   ```
   Update the `^0.1.0` ranges between the packages if the minor version changes, and add the version to [CHANGELOG.md](../CHANGELOG.md).
2. Commit and push to `main`; wait for CI.
3. On GitHub, **create a Release** with the tag `v<version>` (it must match: the workflow refuses a tag that does not), tick **Set as a pre-release** while the packages are alpha, and paste the CHANGELOG entry as the notes.
4. Publishing the release runs the **Release** workflow, which publishes `core`, then `adapters`, then `server` with `--provenance`, so each package on npm carries a verifiable link back to this exact commit.

## After it is out

```bash
npm view @paycryt/server@alpha version
npx @paycryt/server@alpha            # in an empty folder: starts the sandbox
```

Then add the install lines to the root README. Do this **after** the first publish, not before, so the README never promises something that is not there yet.

## Promoting to `latest`

Only when you are happy for `npm install @paycryt/core` (no tag) to resolve to it:

```bash
npm dist-tag add @paycryt/core@0.1.0 latest
npm dist-tag add @paycryt/adapters@0.1.0 latest
npm dist-tag add @paycryt/server@0.1.0 latest
```

## If something goes wrong

- **A bad version is out:** `npm deprecate @paycryt/server@0.1.0 "use 0.1.1: <reason>"`, then publish the fix. `npm unpublish` works for 72 hours but the version number is burned forever, so prefer deprecating.
- **The workflow failed half way:** packages publish in dependency order, so check what actually landed with `npm view <pkg> versions`. You cannot republish a version that exists; bump and release again.
- **A secret leaked:** rotate the `NPM_TOKEN` at once and, if it was ever pushed, treat it as compromised.
