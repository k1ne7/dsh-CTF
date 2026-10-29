import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { definition } from '../plugins/preset.mjs';
test('runtime resolves shipped assets without local configuration', () => {
  const p = definition();
  assert.equal(p.id, 'k1ne-ctf');
  const skills = p.plugins.find(x => x.id === 'skill-filesystem').config.customSkillDirs[0];
  assert.ok(fs.existsSync(skills));
  assert.ok(p.plugins.find(x => x.id === 'ctf-fast-tools').name.startsWith('file:'));
  assert.equal(p.plugins.find(x => x.id === 'tool-pwsh').disabled, process.platform !== 'win32');
  assert.ok(!JSON.stringify(p).includes('__KB_SCRIPT__'));
});
