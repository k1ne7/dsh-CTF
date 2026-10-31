import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { definition } from '../plugins/preset.mjs';
test('runtime resolves shipped assets without local configuration', () => {
  const p = definition();
  assert.equal(p.id, 'k1ne-ctf');
  assert.equal(p.name, 'CTF');
  const { version } = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.ok(p.description.startsWith(`CTF ${version}：`));
  const source = JSON.parse(fs.readFileSync(new URL('../preset.json', import.meta.url), 'utf8'));
  assert.equal(source.description, p.description);
  assert.equal(fs.readdirSync(new URL('../skills/', import.meta.url)).length, 1);
  const skills = p.plugins.find(x => x.id === 'skill-filesystem').config.customSkillDirs[0];
  assert.ok(fs.existsSync(skills));
  assert.ok(p.plugins.find(x => x.id === 'ctf-fast-tools').name.startsWith('file:'));
  assert.equal(p.plugins.find(x => x.id === 'tool-pwsh').disabled, process.platform !== 'win32');
  assert.ok(!JSON.stringify(p).includes('__KB_SCRIPT__'));
});

test('public web tools are opt-in without disabling target shell tools', () => {
  const before = process.env.DSH_CTF_PUBLIC_WEB;
  try {
    delete process.env.DSH_CTF_PUBLIC_WEB;
    assert.equal(definition().plugins.find(x => x.id === 'tool-web').disabled, true);
    process.env.DSH_CTF_PUBLIC_WEB = '1';
    assert.equal(definition().plugins.find(x => x.id === 'tool-web').disabled, false);
    assert.equal(definition().plugins.find(x => x.id === 'tool-pwsh').disabled, process.platform !== 'win32');
  } finally {
    if (before === undefined) delete process.env.DSH_CTF_PUBLIC_WEB;
    else process.env.DSH_CTF_PUBLIC_WEB = before;
  }
});
