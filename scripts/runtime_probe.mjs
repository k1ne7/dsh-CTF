// Test-only host plugin. Creates an idle Agent, inspects actual registrations,
// never sends followup/steer or invokes an LLM/tool/teammate.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
export default class RuntimeProbe {
  static inject = ['agentPresets', 'agents', 'tools', 'systemPrompt', 'skills'];
  constructor(ctx) {
    setTimeout(async () => {
      const result = { ok: false, modelRequests: 0 };
      let handle;
      try {
        await ctx.loader.await();
        const roster = await ctx.agentPresets.list();
        result.preset = roster.find(x => x.id === 'k1ne-ctf');
        if (!result.preset || result.preset.broken) {
          result.inventory = (await ctx.agentPresets.compositionInventory()).find(x => x.id === 'k1ne-ctf');
          throw new Error(JSON.stringify(result.preset ?? roster));
        }
        ctx.on('agent/request', () => { result.modelRequests++; });
        handle = await ctx.agents.create({
          sessionId: `k1ne-preset-probe-${Date.now()}`,
          agentOptions: { provider: 'deepseek-official', model: 'deepseek-flash' },
          setup: async agentCtx => { await ctx.agentPresets.mount(agentCtx, 'k1ne-ctf'); },
        });
        result.tools = ctx.tools.schemas(handle.agent).map(x => x.name);
        if (!result.tools.includes('ctf_batch')) throw new Error('Native batch tool missing');
        const required = ['spawn_teammate', 'send_message', 'list_agents', 'wait_agent',
          'interrupt_agent', 'team_task_create', 'team_task_list', 'team_task_get', 'team_task_update'];
        result.missingTeamTools = required.filter(x => !result.tools.includes(x));
        if (result.missingTeamTools.length) throw new Error('Missing native Team tools');
        const assembly = await ctx.systemPrompt.assemble({ scope: handle.agent,
          agent: handle.agent, session: handle.agent.session,
          provider: 'deepseek-official', model: 'deepseek-flash' });
        result.sections = assembly.sections.map(x => ({ name: x.name, chars: x.text.length }));
        result.personaPresent = assembly.sections.some(x => x.text.includes("You are k1ne's CTF solver"));
        if (!result.personaPresent) throw new Error('Persona missing from actual assembly');
        const persona = assembly.sections.find(x => x.name === 'deployment:persona-prefix')?.text ?? '';
        result.startupDelegationPresent = persona.includes('actively start an appropriate number') &&
          persona.includes('maximum of 4 subagents') && persona.includes('not a fixed one or always four');
        result.knowledgeHelperResolved = persona.includes('/kb_search.py') && !persona.includes('__KB_SCRIPT__');
        result.revisionPresent = persona.includes('K1NE_CTF_PRESET=0.3.0');
        if (!result.startupDelegationPresent || !result.knowledgeHelperResolved) {
          throw new Error('Startup delegation or local knowledge helper missing');
        }
        const skill = await ctx.skills.get('k1ne-ctf', { scope: handle.agent, cwd: root });
        result.skill = skill ? { name: skill.name, path: skill.path, resourceBase: skill.resourceBase } : null;
        if (!skill) throw new Error('Skill missing from actual scoped registry');
        const controller = new AbortController();
        const callBatch = async (args, suffix) => {
          const response = await ctx.tools.execute({ name: 'ctf_batch', arguments: args,
            agent: handle.agent, signal: controller.signal, callId: `batch-probe-${suffix}` });
          if (response.isError) throw new Error(JSON.stringify(response.content));
          return response.value ?? JSON.parse(response.content.find(c => c.type === 'text').text);
        };
        const output = path.join(root, 'artifacts/runtime-batch.json');
        const batch = await callBatch({ steps: [
          { tool: 'read', args: { file_path: path.join(root, 'package.json') } },
          { tool: 'read', args: { file_path: path.join(root, 'persona.md') } },
        ], output_path: output, parallel_reads: true }, 'reads');
        result.nativeBatch = { completed: batch.completed, errors: batch.errors,
          archiveWritten: batch.archive_written, archiveExists: fs.existsSync(batch.archive_path) };
        if (batch.completed !== 2 || batch.errors || !batch.archive_written || !fs.existsSync(batch.archive_path)) {
          throw new Error('Real native batch failed: ' + JSON.stringify(batch));
        }
        const sentinel = path.join(root, 'artifacts/batch-should-not-exist.txt');
        const failed = await callBatch({ steps: [
          { tool: 'read', args: { file_path: path.join(root, 'artifacts/intentionally-missing-file.txt') } },
          { tool: 'write', args: { file_path: sentinel, content: 'unexpected' } },
        ], output_path: path.join(root, 'artifacts/runtime-batch-error.json') }, 'failure');
        result.nativeFailureStops = failed.errors === 1 && failed.skipped === 1 && !fs.existsSync(sentinel);
        if (!result.nativeFailureStops) throw new Error('Native failure did not stop later work');
        const guarded = path.join(root, 'artifacts/guard-fixture.txt');
        fs.writeFileSync(guarded, 'test-only content');
        ctx.tools.guard(execution => execution.name === 'read' && execution.arguments.file_path === guarded
          ? 'K1NE_GUARD_TEST' : undefined);
        const denied = await callBatch({ steps: [{ tool: 'read', args: { file_path: guarded } }],
          output_path: path.join(root, 'artifacts/runtime-batch-guard.json') }, 'guard');
        result.nativePolicyPreserved = denied.errors === 1 && denied.results[0].preview.includes('K1NE_GUARD_TEST');
        if (!result.nativePolicyPreserved) throw new Error('Host guard was not preserved');
        const psError = await callBatch({ steps: [{ tool: 'pwsh', args: {
          description: 'Test local terminating error propagation', command: "Write-Error 'intentional local test error'",
        } }, { tool: 'read', args: { file_path: path.join(root, 'package.json') } }],
        output_path: path.join(root, 'artifacts/runtime-batch-pwsh.json') }, 'pwsh');
        result.nativePwshFailureStops = psError.errors === 1 && psError.skipped === 1;
        if (!result.nativePwshFailureStops) throw new Error('PowerShell error was hidden: ' + JSON.stringify(psError));
        const memory = await ctx.tools.execute({ name: 'ctf_hypotheses', arguments: {
          case_key: 'local-runtime-fixture', action: 'update', expected_revision: 0,
          id: 'h1', statement: 'fixture hypothesis', status: 'refuted', observation: 'runtime counterexample',
          evidence: [batch.archive_path], output_path: path.join(root, 'artifacts/hypothesis-fixture'),
        }, agent: handle.agent, signal: controller.signal, callId: 'hypothesis-probe' });
        if (memory.isError) throw new Error(JSON.stringify(memory.content));
        const refreshed = await ctx.systemPrompt.assemble({ scope: handle.agent, agent: handle.agent,
          session: handle.agent.session, provider: 'deepseek-official', model: 'deepseek-flash' });
        result.sharedEvidenceInjected = JSON.stringify(refreshed).includes('runtime counterexample');
        if (!result.sharedEvidenceInjected) throw new Error('Shared state not injected into actual context');
        result.compositions = ctx.agentPresets.inspectCompositions(handle.agent.ctx).map(x => ({
          id: x.id, leakedServices: x.leakedServices,
        }));
        result.ok = result.revisionPresent && result.compositions.every(x => x.leakedServices.length === 0) && result.modelRequests === 0;
      } catch (error) {
        result.error = error.stack ?? String(error);
      } finally {
        if (handle) await handle.dispose();
        fs.writeFileSync(path.join(root, 'artifacts/runtime-check.json'), JSON.stringify(result, null, 2));
        console.log(`k1ne runtime check: ${result.ok ? 'PASS' : 'FAIL'}`);
      }
    }, 0);
  }
}
