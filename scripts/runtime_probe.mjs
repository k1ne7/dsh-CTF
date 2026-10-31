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
        if (result.preset?.name !== 'CTF') throw new Error('Display name must be CTF');
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
        result.publicWebDisabled = !result.tools.includes('web_search') && !result.tools.includes('web_fetch');
        if (process.env.DSH_CTF_PUBLIC_WEB !== '1' && !result.publicWebDisabled) throw new Error('Public web tools still exposed');
        if (!result.tools.includes('ctf_batch')) throw new Error('Native batch tool missing');
        const required = ['spawn_teammate', 'send_message', 'list_agents', 'wait_agent',
          'interrupt_agent', 'team_task_create', 'team_task_list', 'team_task_get', 'team_task_update'];
        result.missingTeamTools = required.filter(x => !result.tools.includes(x));
        if (result.missingTeamTools.length) throw new Error('Missing native Team tools');
        const assembly = await ctx.systemPrompt.assemble({ scope: handle.agent,
          agent: handle.agent, session: handle.agent.session,
          provider: 'deepseek-official', model: 'deepseek-flash' });
        result.sections = assembly.sections.map(x => ({ name: x.name, chars: x.text.length }));
        result.personaPresent = assembly.sections.some(x => x.text.includes("You are a CTF solving agent"));
        if (!result.personaPresent) throw new Error('Persona missing from actual assembly');
        const persona = assembly.sections.find(x => x.name === 'deployment:persona-prefix')?.text ?? '';
        result.adaptiveDelegation = persona.includes('zero to four') && !persona.includes('must actively start');
        result.revisionPresent = persona.includes('K1NE_CTF_PRESET=0.7.3');
        if (!result.adaptiveDelegation) throw new Error('Adaptive flow missing');
        const skill = await ctx.skills.get('k1ne-ctf', { scope: handle.agent, cwd: root });
        result.skill = skill ? { name: skill.name, path: skill.path, resourceBase: skill.resourceBase } : null;
        if (!skill) throw new Error('Skill missing from actual scoped registry');
        result.singleSkill = !!skill;
        if (result.tools.includes('ctf_chain')) throw new Error('Graph tool must not be in default surface');
        const controller = new AbortController();
        for (const [i, file] of ['package.json', 'persona.md', 'README.md', 'CHANGELOG.md'].entries()) {
          const response = await ctx.tools.execute({name: 'read', arguments: {file_path: path.join(root, file)},
            agent: handle.agent, signal: controller.signal, callId: `checkpoint-probe-${i}`});
          if (response.isError) throw new Error('Delegation checkpoint fixture read failed');
        }
        const checkpoint = await ctx.systemPrompt.assemble({scope: handle.agent, agent: handle.agent,
          session: handle.agent.session, provider: 'deepseek-official', model: 'deepseek-flash'});
        result.delegationCheckpointInjected = JSON.stringify(checkpoint).includes('CTF coordination checkpoint (Lead instruction');
        if (!result.delegationCheckpointInjected) throw new Error('Native delegation checkpoint not injected');
        result.checkpointPreviewSafe = true;
        for (let i = 0; i < 5; i++) {
          const preview = await ctx.systemPrompt.assemble({scope: handle.agent, agent: handle.agent,
            session: handle.agent.session, provider: 'deepseek-official', model: 'deepseek-flash'});
          if (!JSON.stringify(preview).includes('CTF coordination checkpoint (Lead instruction')) {
            result.checkpointPreviewSafe = false;
            throw new Error('Preview assembly consumed delegation checkpoint');
          }
        }
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
        const dependent = await ctx.tools.execute({ name: 'ctf_hypotheses', arguments: {
          case_key: 'local-runtime-fixture', action: 'update', expected_revision: 1,
          id: 'h2', statement: 'dependent branch', status: 'proposed', depends_on: ['h1'],
          distinguishes: 'different observable outcomes', output_path: path.join(root, 'artifacts/hypothesis-dependent'),
        }, agent: handle.agent, signal: controller.signal, callId: 'dependent-probe' });
        if (dependent.isError) throw new Error(JSON.stringify(dependent.content));
        const view = await ctx.tools.execute({ name: 'ctf_hypotheses', arguments: {
          case_key: 'local-runtime-fixture', action: 'list',
        }, agent: handle.agent, signal: controller.signal, callId: 'dependent-list' });
        const state = view.value ?? JSON.parse(view.content.find(x => x.type === 'text').text);
        result.dependenciesVerified = state.hypotheses.h2.status === 'proposed' &&
          state.hypotheses.h2.blocked_by_refuted.includes('h1');
        if (!result.dependenciesVerified) throw new Error('Dependency propagation failed');
        const feedbackCall = await ctx.tools.execute({ name: 'read', arguments: {
          file_path: path.join(root, 'artifacts/feedback-intentionally-missing.txt') }, agent: handle.agent,
          signal: controller.signal, callId: 'feedback-probe' });
        if (!feedbackCall.isError) throw new Error('Missing fixture unexpectedly readable');
        const feedbackAssembly = await ctx.systemPrompt.assemble({ scope: handle.agent, agent: handle.agent,
          session: handle.agent.session, provider: 'deepseek-official', model: 'deepseek-flash' });
        result.executionFeedbackInjected = JSON.stringify(feedbackAssembly).includes('Execution feedback (observations');
        if (!result.executionFeedbackInjected) throw new Error('Native feedback hook did not run');
        // Deterministic host guard fixture: distinct inputs, equal observations.
        // Avoid requiring shell sandbox ACL changes merely to test observation.
        const stallPrefix = path.join(root, 'artifacts/stall-fixture-');
        ctx.tools.guard(execution => execution.name === 'read' &&
          execution.arguments.file_path?.startsWith(stallPrefix) ? 'CTF_EQUAL_RESULT_FIXTURE' : undefined);
        for (let i = 0; i < 3; i++) {
          const observed = await ctx.tools.execute({name: 'read', arguments: {
            file_path: stallPrefix + i,
          }, agent: handle.agent, signal: controller.signal, callId: `stall-probe-${i}`});
          if (!observed.isError) throw new Error('Stall guard fixture did not run');
        }
        const stalledAssembly = await ctx.systemPrompt.assemble({scope: handle.agent, agent: handle.agent,
          session: handle.agent.session, provider: 'deepseek-official', model: 'deepseek-flash'});
        result.stallFeedbackInjected = JSON.stringify(stalledAssembly).includes('possible_stall\\\":true');
        if (!result.stallFeedbackInjected) throw new Error('Native equal-output feedback did not run');
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
