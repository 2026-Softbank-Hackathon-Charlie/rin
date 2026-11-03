import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rin-ws-'));
process.env.RIN_WORKSPACE = path.join(tmp, 'workspace');
process.env.RIN_CLAUDE_CONFIG_DIR = path.join(tmp, 'claude');
const { ensureWorkspace } = await import('../src/worker/workspace.js');

test('repo skills are installed and overwrite stale copies, other skills stay', () => {
  const skills = path.join(tmp, 'workspace', '.claude', 'skills');
  ensureWorkspace();
  const visuals = path.join(skills, 'visuals', 'SKILL.md');
  const shipped = fs.readFileSync(visuals, 'utf8');
  assert.match(shipped, /^---\nname: visuals\n/);

  fs.writeFileSync(visuals, 'old copy');
  fs.mkdirSync(path.join(skills, 'team-made'), { recursive: true });
  fs.writeFileSync(path.join(skills, 'team-made', 'SKILL.md'), 'kept');
  ensureWorkspace();
  assert.equal(fs.readFileSync(visuals, 'utf8'), shipped);
  assert.equal(fs.readFileSync(path.join(skills, 'team-made', 'SKILL.md'), 'utf8'), 'kept');
});
