import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

export function definition() {
  const preset = JSON.parse(fs.readFileSync(new URL('../preset.json', import.meta.url), 'utf8'));
  const { version } = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  preset.description = `CTF ${version}：证据驱动、适时分工、停滞与执行反馈`;
  const resolve = file => fileURLToPath(new URL('../' + file, import.meta.url)).replaceAll('\\', '/');
  for (const row of preset.plugins) {
    if (row.id === 'tool-bash') row.disabled = process.platform === 'win32';
    if (row.id === 'tool-pwsh') row.disabled = process.platform !== 'win32';
    if (row.id === 'tool-web') row.disabled = process.env.DSH_CTF_PUBLIC_WEB !== '1';
    if (row.id === 'persona') {
      row.config.prefix = row.config.prefix.replaceAll('__KB_SCRIPT__', resolve('skills/k1ne-ctf/scripts/kb_search.py'))
        .replaceAll('__EXEC_SCRIPT__', resolve('skills/k1ne-ctf/scripts/ctf_exec.py'))
        .replaceAll('__KNOWLEDGE_ROOT__', process.env.DSH_CTF_KB || resolve('vendor/ctf-knowledge'));
    }
    if (row.id === 'skill-filesystem') row.config.customSkillDirs = [resolve('skills')];
    if (row.id === 'ctf-fast-tools') row.name = new URL('./fast-tools.mjs', import.meta.url).href;
  }
  return preset;
}

export const inject = ['agentPresets'];
export default async function apply(ctx) {
  return await ctx.agentPresets.register(definition());
}
apply.inject = ['agentPresets'];
