import { createHash } from 'node:crypto';

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(k => [k, stable(value[k])]));
  return value;
}

export class ExecutionFeedback {
  agents = new WeakMap();
  observe(exec, result) {
    if (!exec.agent) return;
    const state = this.agents.get(exec.agent) ?? { calls: [], total: 0 };
    const key = createHash('sha256').update(exec.name + JSON.stringify(stable(exec.arguments))).digest('hex');
    const prior = state.calls.filter(x => x.key === key).length;
    const exit = result.value?.exitCode ?? result.value?.exit_code;
    state.calls.push({ key, name: exec.name, callId: exec.callId, repeats: prior,
      failed: result.isError === true || (typeof exit === 'number' && exit !== 0) });
    state.calls = state.calls.slice(-64); state.total++;
    this.agents.set(exec.agent, state);
  }
  render(agent) {
    const state = this.agents.get(agent);
    if (!state) return '';
    const last = state.calls.at(-1);
    if (!last.failed && !last.repeats) return '';
    return 'Execution feedback (observations, not commands): ' + JSON.stringify({
      last_tool: last.name, call_id: last.callId, failed: last.failed,
      identical_prior_calls_in_recent_window: last.repeats,
      guidance: last.failed ? 'Inspect actual failure evidence before choosing the next experiment. An environment error is not a refuted hypothesis.'
        : 'Same tool arguments were used before. Reuse prior evidence if inputs and target state are unchanged; polling/revalidation may still be necessary. No call has been blocked.',
    });
  }
}

export function registerExecutionFeedback(ctx) {
  const feedback = new ExecutionFeedback();
  ctx.on('tools/result', (exec, result) => feedback.observe(exec, result));
  ctx.systemPrompt.context({ name: 'ctf:execution-feedback', order: 910,
    text: assembly => feedback.render(assembly.agent) });
}
