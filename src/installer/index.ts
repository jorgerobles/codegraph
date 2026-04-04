/**
 * CodeGraph Interactive Installer
 *
 * Uses @clack/prompts for a polished interactive CLI experience.
 */

import { execSync } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import {
  writeMcpConfig, writePermissions, writeClaudeMd, writeHooks,
  hasMcpConfig, hasPermissions, hasHooks,
} from './config-writer';

import type { InstallLocation } from './config-writer';

// Dynamic import helper — tsc compiles import() to require() in CJS mode,
// which fails for ESM-only packages. This bypasses the transformation.
// eslint-disable-next-line @typescript-eslint/no-implied-eval
const importESM = new Function('specifier', 'return import(specifier)') as
  (specifier: string) => Promise<typeof import('@clack/prompts')>;

/**
 * Format a number with commas
 */
function formatNumber(n: number): string {
  return n.toLocaleString();
}

/**
 * Get the package version
 */
function getVersion(): string {
  try {
    const packageJsonPath = path.join(__dirname, '..', '..', 'package.json');
    const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf-8'));
    return packageJson.version;
  } catch {
    return '0.0.0';
  }
}

/**
 * Run the interactive installer
 */
export async function runInstaller(): Promise<void> {
  const clack = await importESM('@clack/prompts');

  clack.intro(`CodeGraph v${getVersion()}`);

  // Step 1: Install globally
  const shouldInstallGlobally = await clack.confirm({
    message: 'Install codegraph globally? (Required for hooks & MCP server)',
    initialValue: true,
  });

  if (clack.isCancel(shouldInstallGlobally)) {
    clack.cancel('Installation cancelled.');
    process.exit(0);
  }

  if (shouldInstallGlobally) {
    const s = clack.spinner();
    s.start('Installing codegraph globally...');
    try {
      execSync('npm install -g @colbymchenry/codegraph', { stdio: 'pipe' });
      s.stop('Installed codegraph globally');
    } catch {
      s.stop('Could not install globally (permission denied)');
      clack.log.warn('Try: sudo npm install -g @colbymchenry/codegraph');
    }
  } else {
    clack.log.info('Skipped global install — hooks and MCP server may not work without it');
  }

  // Step 2: Installation location
  const location = await clack.select({
    message: 'Where would you like to install?',
    options: [
      { value: 'global' as const, label: 'Global', hint: '~/.claude — available in all projects' },
      { value: 'local' as const, label: 'Local', hint: './.claude — this project only' },
    ],
    initialValue: 'global' as const,
  });

  if (clack.isCancel(location)) {
    clack.cancel('Installation cancelled.');
    process.exit(0);
  }

  // Step 3: Auto-allow permissions
  const autoAllow = await clack.confirm({
    message: 'Auto-allow CodeGraph commands? (Skips permission prompts)',
    initialValue: true,
  });

  if (clack.isCancel(autoAllow)) {
    clack.cancel('Installation cancelled.');
    process.exit(0);
  }

  // Step 4: Write configuration files
  writeConfigs(clack, location, autoAllow);

  // Step 5: For local install, initialize the project
  if (location === 'local') {
    await initializeLocalProject(clack);
  }

  // Done
  if (location === 'global') {
    clack.note(
      'cd your-project\ncodegraph init -i',
      'Quick start',
    );
  }

  clack.outro('Done! Restart Claude Code to use CodeGraph.');
}

/**
 * Write all configuration files and log results
 */
function writeConfigs(
  clack: typeof import('@clack/prompts'),
  location: InstallLocation,
  autoAllow: boolean,
): void {
  const locationLabel = location === 'global' ? '~/.claude' : './.claude';

  // MCP config
  const mcpAction = hasMcpConfig(location) ? 'Updated' : 'Added';
  writeMcpConfig(location);
  clack.log.success(`${mcpAction} MCP server in ${locationLabel}.json`);

  // Permissions
  if (autoAllow) {
    const permAction = hasPermissions(location) ? 'Updated' : 'Added';
    writePermissions(location);
    clack.log.success(`${permAction} permissions in ${locationLabel}/settings.json`);
  }

  // Hooks
  const hookAction = hasHooks(location) ? 'Updated' : 'Added';
  writeHooks(location);
  clack.log.success(`${hookAction} auto-sync hooks in ${locationLabel}/settings.json`);

  // CLAUDE.md
  const claudeMdResult = writeClaudeMd(location);
  const claudeMdPath = `${locationLabel}/CLAUDE.md`;
  if (claudeMdResult.created) {
    clack.log.success(`Created ${claudeMdPath}`);
  } else if (claudeMdResult.updated) {
    clack.log.success(`Updated ${claudeMdPath}`);
  } else {
    clack.log.success(`Added CodeGraph instructions to ${claudeMdPath}`);
  }
}

/**
 * Initialize CodeGraph in the current project (for local installs)
 */
async function initializeLocalProject(clack: typeof import('@clack/prompts')): Promise<void> {
  const projectPath = process.cwd();

  // Lazy-load CodeGraph (requires native modules)
  let CodeGraph: typeof import('../index').default;
  try {
    CodeGraph = (await import('../index')).default;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    clack.log.error(`Could not load native modules: ${msg}`);
    clack.log.info('Skipping project initialization. Run "codegraph init -i" later.');
    return;
  }

  // Check if already initialized
  if (CodeGraph.isInitialized(projectPath)) {
    clack.log.info('CodeGraph already initialized in this project');
    return;
  }

  // Initialize
  const cg = await CodeGraph.init(projectPath);
  clack.log.success('Created .codegraph/ directory');

  // Index the project with shimmer progress
  const SPINNER_GLYPHS = ['·', '✢', '✳', '✶', '✻', '✽'];
  const ANIM_INTERVAL = 150;
  const FRAMES_PER_GLYPH = 3;
  const _lerp = (a: number, b: number, t: number) => Math.round(a + (b - a) * t);
  const _shimmerColor = (frame: number) => {
    const t = (Math.sin(frame * 2 * Math.PI / 13) + 1) / 2;
    return `\x1b[38;2;${_lerp(160, 251, t)};${_lerp(100, 191, t)};${_lerp(9, 36, t)}m\x1b[1m`;
  };
  const rst = '\x1b[0m';
  const dm = '\x1b[2m';
  const grn = '\x1b[32m';
  const phaseNames: Record<string, string> = {
    scanning: 'Scanning files',
    parsing: 'Parsing code',
    storing: 'Storing data',
    resolving: 'Resolving refs',
  };

  const _startTime = Date.now();
  const _animFrame = () => Math.floor((Date.now() - _startTime) / ANIM_INTERVAL);
  let curMsg = '';
  let curPercent = -1;
  let curCount = 0;
  let lastPhase = '';

  const renderBar = (filled: number, empty: number): string => {
    if (filled === 0) return `${dm}${'░'.repeat(empty)}${rst}`;
    const cycleFrames = 24;
    const shimmerPos = ((_animFrame() % cycleFrames) / cycleFrames) * (filled + 6) - 3;
    const shimmerWidth = 3;
    let bar = '';
    for (let i = 0; i < filled; i++) {
      const dist = Math.abs(i - shimmerPos);
      const t = Math.max(0, 1 - dist / shimmerWidth);
      const r = _lerp(160, 251, t);
      const g = _lerp(100, 191, t);
      const b = _lerp(9, 36, t);
      bar += `\x1b[38;2;${r};${g};${b}m\x1b[1m█`;
    }
    return bar + `${rst}${dm}${'░'.repeat(empty)}${rst}`;
  };

  const renderTick = () => {
    const frame = _animFrame();
    const glyph = SPINNER_GLYPHS[Math.floor(frame / FRAMES_PER_GLYPH) % SPINNER_GLYPHS.length];
    const color = _shimmerColor(frame);
    let line: string;
    if (curPercent >= 0) {
      const barW = 25, filled = Math.round(barW * curPercent / 100), empty = barW - filled;
      line = `${dm}│${rst}  ${color}${glyph}${rst} ${curMsg}  ${renderBar(filled, empty)}  ${curPercent}%`;
    } else if (curCount > 0) {
      line = `${dm}│${rst}  ${color}${glyph}${rst} ${curMsg}... ${formatNumber(curCount)} found`;
    } else {
      line = `${dm}│${rst}  ${color}${glyph}${rst} ${curMsg}...`;
    }
    process.stdout.write(`\r\x1b[K${line}`);
  };

  const finishPhase = () => {
    if (!curMsg) return;
    process.stdout.write(`\r\x1b[K`);
    let detail = '';
    if (curPercent >= 0) detail = ' — done';
    else if (curCount > 0) detail = ` — ${formatNumber(curCount)} found`;
    process.stdout.write(`${dm}│${rst}  ${grn}◆${rst} ${curMsg}${detail}\n`);
  };

  process.stdout.write(`${dm}│${rst}\n`);
  const ticker = setInterval(renderTick, ANIM_INTERVAL);

  const result = await cg.indexAll({
    onProgress: (progress) => {
      const phaseName = phaseNames[progress.phase] || progress.phase;
      if (progress.phase !== lastPhase && lastPhase) finishPhase();
      lastPhase = progress.phase;
      curMsg = phaseName;
      if (progress.total > 0) { curPercent = Math.round((progress.current / progress.total) * 100); curCount = 0; }
      else if (progress.current > 0) { curPercent = -1; curCount = progress.current; }
      else { curPercent = -1; curCount = 0; }
      renderTick();
    },
  });

  clearInterval(ticker);
  finishPhase();

  if (result.filesErrored > 0) {
    clack.log.success(`Indexed ${formatNumber(result.filesIndexed)} files (${formatNumber(result.filesErrored)} failed, ${formatNumber(result.nodesCreated)} symbols)`);
  } else {
    clack.log.success(`Indexed ${formatNumber(result.filesIndexed)} files (${formatNumber(result.nodesCreated)} symbols)`);
  }

  cg.close();
}

// Re-export for CLI
export type { InstallLocation };
