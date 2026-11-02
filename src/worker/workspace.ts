import fs from 'node:fs';
import path from 'node:path';
import { appRoot, config } from '../config.js';

/**
 * Prepares the shared workspace every run uses as cwd. Existing files are kept,
 * so CLAUDE.md, skills and memory written by earlier runs survive restarts.
 */
export function ensureWorkspace(): void {
  const dir = config.workspaceDir;
  for (const sub of ['.claude/skills', 'memory', 'repos', 'worktrees']) {
    fs.mkdirSync(path.join(dir, sub), { recursive: true });
  }
  fs.mkdirSync(config.claudeConfigDir, { recursive: true });

  const claudeMd = path.join(dir, 'CLAUDE.md');
  if (!fs.existsSync(claudeMd)) fs.copyFileSync(path.join(appRoot, 'workspace-template', 'CLAUDE.md'), claudeMd);

  // Auto memory lives inside the workspace so it is shared by every run and easy to back up.
  const settingsPath = path.join(dir, '.claude', 'settings.json');
  const settings: Record<string, unknown> = fs.existsSync(settingsPath) ? JSON.parse(fs.readFileSync(settingsPath, 'utf8')) : {};
  settings.autoMemoryEnabled = true;
  settings.autoMemoryDirectory = path.join(dir, 'memory');
  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n');
}
