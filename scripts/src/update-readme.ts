/**
 * Regenerates the auto-managed sections of the repo-root README.md from real
 * sources of truth:
 *
 *   • <!-- AUTO:ARTIFACTS --> ... <!-- /AUTO:ARTIFACTS -->
 *       Pulled from each artifact's `.replit-artifact/artifact.toml`
 *       (kind, title, previewPath, dev/prod commands).
 *   • <!-- AUTO:SCRIPTS --> ... <!-- /AUTO:SCRIPTS -->
 *       Pulled from the root `package.json` `scripts` map plus per-artifact
 *       script names (`dev`, `build`, `test`, `typecheck`).
 *   • <!-- AUTO:FEATURES --> ... <!-- /AUTO:FEATURES -->
 *       Pulled from the curated `scripts/README-FEATURES.json` file. Edit
 *       that file when a new feature ships; this script just renders it.
 *
 * The script is idempotent — running it twice produces no diff. It only
 * touches content **between** the marker pairs; the hand-written prose
 * around them is left alone.
 *
 * Run: `pnpm readme` (or `tsx scripts/src/update-readme.ts`).
 * Triggered automatically from `scripts/post-merge.sh` after each merge.
 */
import { readFileSync, writeFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

const REPO_ROOT = resolve(new URL('.', import.meta.url).pathname, '../..');
const README_PATH = join(REPO_ROOT, 'README.md');
const FEATURES_PATH = join(REPO_ROOT, 'scripts/README-FEATURES.json');

interface ArtifactInfo {
  dir: string;
  title: string;
  kind: string;
  previewPath: string;
  devRun: string | null;
  prodRun: string | null;
}

// Tiny purpose-built TOML reader. We only need flat `key = "value"` pairs
// and a couple of inline arrays inside `[services.development]` /
// `[services.production.run]` tables — bringing in a TOML dep just for
// this would be overkill.
function readArtifactToml(tomlPath: string): Partial<ArtifactInfo> {
  const text = readFileSync(tomlPath, 'utf8');
  const out: Partial<ArtifactInfo> = {};
  let section = '';
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, '').trim();
    if (!line) continue;
    const sec = line.match(/^\[(.+)\]$/);
    if (sec) {
      section = sec[1]!;
      continue;
    }
    const kv = line.match(/^([A-Za-z0-9_]+)\s*=\s*(.+)$/);
    if (!kv) continue;
    const [, key, rawVal] = kv;
    const val = stripQuotes(rawVal!);
    if (section === '' || section.startsWith('[')) {
      // Top-level scalars only.
      if (key === 'kind') out.kind = val;
      else if (key === 'title') out.title = val;
      else if (key === 'previewPath') out.previewPath = val;
    } else if (section === 'services.development' && key === 'run') {
      out.devRun = val.startsWith('[') ? joinTomlArray(val) : val;
    } else if (
      (section === 'services.production' || section === 'services.production.run') &&
      key === 'run'
    ) {
      out.prodRun = val.startsWith('[') ? joinTomlArray(val) : val;
    } else if (section === 'services.production.run' && key === 'args') {
      out.prodRun = joinTomlArray(val);
    } else if (section === 'services.production.build' && key === 'args') {
      // build args alone aren't surfaced; dev/prod run is enough for the table.
    }
  }
  return out;
}

function stripQuotes(s: string): string {
  const t = s.trim();
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) {
    return t.slice(1, -1);
  }
  return t;
}

function joinTomlArray(s: string): string {
  // ["pnpm", "--filter", "x", "run", "build"]  →  pnpm --filter x run build
  const inner = s.trim().replace(/^\[/, '').replace(/\]$/, '');
  return inner
    .split(',')
    .map((p) => stripQuotes(p.trim()))
    .filter(Boolean)
    .join(' ');
}

function discoverArtifacts(): ArtifactInfo[] {
  const root = join(REPO_ROOT, 'artifacts');
  if (!existsSync(root)) return [];
  const out: ArtifactInfo[] = [];
  for (const name of readdirSync(root).sort()) {
    const dir = join(root, name);
    if (!statSync(dir).isDirectory()) continue;
    const toml = join(dir, '.replit-artifact/artifact.toml');
    if (!existsSync(toml)) continue;
    const partial = readArtifactToml(toml);
    out.push({
      dir: `artifacts/${name}`,
      title: partial.title ?? name,
      kind: partial.kind ?? '?',
      previewPath: partial.previewPath ?? '/',
      devRun: partial.devRun ?? null,
      prodRun: partial.prodRun ?? null,
    });
  }
  return out;
}

function renderArtifactsTable(arts: ArtifactInfo[]): string {
  const rows = arts.map(
    (a) =>
      `| ${a.title} | \`${a.kind}\` | \`${a.dir}\` | \`${a.previewPath}\` | ${a.devRun ? `\`${a.devRun}\`` : '—'} |`
  );
  return [
    '| Title | Kind | Directory | Preview path | Dev command |',
    '| --- | --- | --- | --- | --- |',
    ...rows,
  ].join('\n');
}

interface PkgScripts {
  name: string;
  dir: string;
  scripts: Record<string, string>;
}

function readPackageScripts(pkgJsonPath: string, dir: string): PkgScripts | null {
  if (!existsSync(pkgJsonPath)) return null;
  const pkg = JSON.parse(readFileSync(pkgJsonPath, 'utf8'));
  return { name: pkg.name ?? dir, dir, scripts: pkg.scripts ?? {} };
}

function renderScriptsSection(): string {
  const root = readPackageScripts(join(REPO_ROOT, 'package.json'), '.')!;
  const artScripts = discoverArtifacts()
    .map((a) => readPackageScripts(join(REPO_ROOT, a.dir, 'package.json'), a.dir))
    .filter((p): p is PkgScripts => p !== null);

  const lines: string[] = [];
  lines.push('**Workspace root** (`pnpm <name>`):');
  lines.push('');
  lines.push('| Script | Command |');
  lines.push('| --- | --- |');
  for (const [name, cmd] of Object.entries(root.scripts).sort()) {
    if (name === 'preinstall') continue;
    lines.push(`| \`${name}\` | \`${truncateCmd(cmd)}\` |`);
  }
  lines.push('');
  lines.push('**Per-artifact** (run with `pnpm --filter <name> <script>`):');
  lines.push('');
  lines.push('| Package | Scripts |');
  lines.push('| --- | --- |');
  for (const p of artScripts) {
    const names =
      Object.keys(p.scripts)
        .sort()
        .map((s) => `\`${s}\``)
        .join(', ') || '—';
    lines.push(`| \`${p.name}\` | ${names} |`);
  }
  return lines.join('\n');
}

function truncateCmd(cmd: string): string {
  // Keep table cells readable; long inline-shell scripts (e.g. preinstall)
  // get clipped with an ellipsis and a hint.
  const oneLine = cmd.replace(/\s+/g, ' ').trim();
  if (oneLine.length <= 90) return oneLine;
  return oneLine.slice(0, 87) + '…';
}

interface FeaturesFile {
  features: Array<{ area: string; title: string; detail: string }>;
}

function renderFeaturesSection(): string {
  if (!existsSync(FEATURES_PATH))
    return '_(no features manifest found at `scripts/README-FEATURES.json`)_';
  const data = JSON.parse(readFileSync(FEATURES_PATH, 'utf8')) as FeaturesFile;
  const byArea = new Map<string, FeaturesFile['features']>();
  for (const f of data.features) {
    const list = byArea.get(f.area) ?? [];
    list.push(f);
    byArea.set(f.area, list);
  }
  const out: string[] = [];
  for (const [area, list] of byArea) {
    out.push(`**${area}**`);
    out.push('');
    for (const f of list) out.push(`- **${f.title}** — ${f.detail}`);
    out.push('');
  }
  return out.join('\n').trimEnd();
}

function replaceBlock(src: string, marker: string, body: string): string {
  const open = `<!-- AUTO:${marker} -->`;
  const close = `<!-- /AUTO:${marker} -->`;
  const re = new RegExp(`${escapeRegex(open)}[\\s\\S]*?${escapeRegex(close)}`, 'g');
  if (!re.test(src)) {
    throw new Error(`README is missing marker pair: ${open} ... ${close}`);
  }
  return src.replace(re, `${open}\n${body}\n${close}`);
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function main(): void {
  if (!existsSync(README_PATH)) {
    throw new Error(`README not found at ${README_PATH}. Create it with the AUTO markers first.`);
  }
  let readme = readFileSync(README_PATH, 'utf8');
  readme = replaceBlock(readme, 'ARTIFACTS', renderArtifactsTable(discoverArtifacts()));
  readme = replaceBlock(readme, 'SCRIPTS', renderScriptsSection());
  readme = replaceBlock(readme, 'FEATURES', renderFeaturesSection());
  writeFileSync(README_PATH, readme);

  console.log(`[update-readme] wrote ${README_PATH}`);
}

main();
