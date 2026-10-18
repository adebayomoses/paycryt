// Pre-publish checks for the three npm packages (@paycryt/core, /adapters, /server).
//
//   npm run build && npm run release:check
//
// Also runs as each package's `prepublishOnly`, so even a hand-typed `npm publish` cannot ship a package whose
// generated files are missing (the server's ui/pos.js only exists after `npm run build`), whose version drifted from
// the others, or whose tarball contains something it should not. Exits 1 and says exactly what is wrong.
//
//   --tag vX.Y.Z   also require that a release tag matches the package version (used by the release workflow)
import { execSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const read = (p) => JSON.parse(readFileSync(root + p, 'utf8'));
const PACKAGES = ['core', 'adapters', 'server'];
const problems = [];
const bad = (pkg, msg) => problems.push(`${pkg}: ${msg}`);

const rootPkg = read('package.json');
const pkgs = Object.fromEntries(PACKAGES.map((n) => [n, read(`packages/${n}/package.json`)]));
const workspaceVersions = Object.fromEntries(Object.values(pkgs).map((p) => [p.name, p.version]));
const rootLicense = readFileSync(root + 'LICENSE', 'utf8');

const tagAt = process.argv.indexOf('--tag');
if (tagAt > -1 && process.argv[tagAt + 1] !== `v${rootPkg.version}`) {
  bad('release', `tag "${process.argv[tagAt + 1]}" does not match the version ${rootPkg.version} (expected v${rootPkg.version})`);
}

/** Does `version` satisfy the caret range `^x.y.z`? Enough semver for our own dependency ranges. */
function caretOk(range, version) {
  const m = /^\^(\d+)\.(\d+)\.(\d+)$/.exec(range);
  if (!m) return false; // we only use plain caret ranges between our own packages
  const r = m.slice(1).map(Number);
  const v = version.split('.').map((x) => parseInt(x, 10));
  if (v.some(Number.isNaN)) return false;
  const geq = v[0] > r[0] || (v[0] === r[0] && (v[1] > r[1] || (v[1] === r[1] && v[2] >= r[2])));
  if (r[0] > 0) return v[0] === r[0] && geq;
  if (r[1] > 0) return v[0] === 0 && v[1] === r[1] && geq;
  return v[0] === 0 && v[1] === 0 && v[2] === r[2];
}

const MUST_SHIP = { core: ['dist/index.js', 'dist/index.d.ts'], adapters: ['dist/index.js', 'dist/index.d.ts'], server: ['dist/index.js', 'dist/index.d.ts', 'dist/cli.js', 'ui/index.html', 'ui/app.js', 'ui/pos.html', 'ui/pos.js', 'ui/pos-sw.js', 'ui/manifest.webmanifest', 'ui/icon.svg'] };
const NEVER_SHIP = [/(^|\/)src\//, /(^|\/)test\//, /(^|\/)pos\//, /(^|\/)scripts\//, /tsbuildinfo/, /\.env/, /\.(db|sqlite)(-wal|-shm)?$/, /(^|\/)node_modules\//, /\.test\./];

const rows = [];
for (const name of PACKAGES) {
  const p = pkgs[name];
  const dir = `packages/${name}/`;
  const id = p.name;
  if (p.private) bad(id, 'is marked private, so npm would refuse to publish it');
  if (p.license !== 'MIT') bad(id, `license is "${p.license}", expected MIT`);
  if (p.version !== rootPkg.version) bad(id, `version ${p.version} differs from the repo version ${rootPkg.version}; the three packages are released in lockstep`);
  if (!p.description) bad(id, 'has no description');
  if (!p.repository?.url || p.repository.directory !== `packages/${name}`) bad(id, 'repository.url / repository.directory is missing or wrong');
  if (!p.bugs?.url || !p.homepage) bad(id, 'bugs.url or homepage is missing');
  if (!p.keywords?.length) bad(id, 'has no keywords');
  if (p.publishConfig?.access !== 'public') bad(id, 'publishConfig.access must be "public" (a scoped package defaults to private)');
  if (!p.publishConfig?.tag) bad(id, 'publishConfig.tag is not set, so a plain `npm publish` would claim the "latest" tag for an alpha');
  if (!p.scripts?.prepublishOnly) bad(id, 'has no prepublishOnly guard');
  if (!p.files?.length) bad(id, 'has no "files" allow-list, so the tarball could include anything');

  for (const [dep, range] of Object.entries(p.dependencies ?? {})) {
    if (dep in workspaceVersions && !caretOk(range, workspaceVersions[dep])) bad(id, `depends on ${dep}@${range} but the repo has ${workspaceVersions[dep]}`);
  }

  if (!existsSync(root + dir + 'LICENSE')) bad(id, 'has no LICENSE file in its folder (npm ships the one next to package.json)');
  else if (readFileSync(root + dir + 'LICENSE', 'utf8') !== rootLicense) bad(id, 'LICENSE differs from the repo-root LICENSE');
  if (!existsSync(root + dir + 'README.md')) bad(id, 'has no README.md, so its npm page would be empty');
  else if (readFileSync(root + dir + 'README.md', 'utf8').length < 600) bad(id, 'README.md is a stub');

  for (const f of MUST_SHIP[name]) if (!existsSync(root + dir + f)) bad(id, `${f} does not exist. Run \`npm run build\` first`);
  if (p.bin) {
    for (const [cmd, file] of Object.entries(p.bin)) {
      const path = root + dir + file.replace(/^\.\//, '');
      if (!existsSync(path)) bad(id, `bin "${cmd}" points at ${file}, which does not exist`);
      else if (!readFileSync(path, 'utf8').startsWith('#!')) bad(id, `bin "${cmd}" (${file}) has no #! line, so it will not run as a command`);
    }
  }

  // What would actually be uploaded.
  let packed;
  try {
    packed = JSON.parse(execSync('npm pack --dry-run --json', { cwd: root + dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }))[0];
  } catch (err) {
    bad(id, `npm pack failed: ${String(err.stderr || err.message).split('\n')[0]}`);
    continue;
  }
  const files = packed.files.map((f) => f.path);
  for (const must of ['package.json', 'LICENSE', 'README.md', ...MUST_SHIP[name]]) if (!files.includes(must)) bad(id, `tarball is missing ${must}`);
  for (const f of files) if (NEVER_SHIP.some((re) => re.test(f))) bad(id, `tarball would include ${f}, which should never be published`);
  rows.push({ package: `${id}@${p.version}`, tag: p.publishConfig?.tag ?? '-', files: files.length, 'packed kB': (packed.size / 1024).toFixed(0), 'unpacked kB': (packed.unpackedSize / 1024).toFixed(0) });
}

console.table(rows);
if (problems.length) {
  console.error(`\nNot ready to publish. ${problems.length} problem${problems.length === 1 ? '' : 's'}:`);
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}
console.log('Release check passed: metadata, licences, build outputs and tarball contents are all as expected.');
