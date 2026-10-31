import { createHash } from 'node:crypto';

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(k => [k, stable(value[k])]));
  return value;
}

export class ExecutionFeedback {
  agents = new WeakMap();
  observe(exec, result) {
    if (!exec.agent || typeof exec.agent !== 'object') return;
    const state = this.agents.get(exec.agent) ?? { calls: [], total: 0, delegationAttempts: 0 };
    if (exec.name === 'spawn_teammate') {
      // An attempt, including a failed one, suppresses automatic re-prompting.
      // The host and model retain ownership of scheduling/recovery.
      state.delegationAttempts++;
      this.agents.set(exec.agent, state);
      return;
    }
    // Observe leaf work, not wrappers or coordination. A successful message or
    // archive write must not clear a stalled experiment's feedback.
    if (['ctf_batch', 'ctf_hypotheses', 'write', 'edit', 'skill', 'list_agents',
      'spawn_teammate', 'send_message', 'interrupt_agent', 'job_output',
      'job_kill', 'wait', 'todo_write', 'working_directory'].includes(exec.name)) return;
    const key = createHash('sha256').update(exec.name + JSON.stringify(stable(exec.arguments))).digest('hex');
    const prior = state.calls.filter(x => x.key === key).length;
    const exit = result.value?.exitCode ?? result.value?.exit_code;
    const text = (result.content ?? []).filter(x => x.type === 'text' && typeof x.text === 'string').map(x => x.text).join('\n');
    const failed = result.isError === true || (typeof exit === 'number' && exit !== 0);
    const output = text.trim() ? createHash('sha256').update(exec.name + '\0' + failed + '\0' + text).digest('hex') : null;
    state.calls.push({ key, name: exec.name, callId: exec.callId, repeats: prior,
      output, failed, environment_error: ['pwsh', 'bash', 'shell', 'exec_command'].includes(exec.name) &&
        /spawn EPERM|SetNamedSecurityInfoW|UnauthorizedAccessException|ParserError/.test(text) });
    state.calls = state.calls.slice(-64); state.total++;
    this.agents.set(exec.agent, state);
  }
  render(agent) {
    const state = this.agents.get(agent);
    if (!state) return '';
    const last = state.calls.at(-1);
    if (!last) return '';
    const recent = state.calls.slice(-6);
    const same = last.output ? recent.filter(x => x.output === last.output) : [];
    const variants = new Set(same.map(x => x.key)).size;
    const stalled = same.length >= 3 && variants >= 3;
    // Rendering may occur during previews and preflight assembly. It MUST be
    // pure: keep the bounded snapshot until an actual native spawn attempt.
    // This is pending cooperation, not a claimed model-delivery receipt.
    const delegationCheckpoint = !state.delegationAttempts && state.total >= 4;
    if (!last.failed && !last.repeats && !stalled && !delegationCheckpoint && !last.environment_error) return '';
    const coordination = delegationCheckpoint ? 'CTF coordination checkpoint (Lead instruction, separate from result observations): For a nontrivial task with native Team available, call spawn_teammate now for one genuinely independent unresolved question or read-only evidence review, then continue the main experiment. Give actual observations and a decision criterion. Short or strictly serial work needs no teammate; unavailable slots/tool failures require direct fallback, not repeated spawning. Teammates must not spawn nested managers. Do not duplicate experiments or mutate shared target state concurrently.\n' : '';
    return coordination + 'Execution feedback (observations, not commands): ' + JSON.stringify({
      last_tool: last.name, call_id: last.callId, failed: last.failed,
      identical_prior_calls_in_recent_window: last.repeats,
      same_result_distinct_arguments: variants, possible_stall: stalled,
      environment_error: last.environment_error,
      delegation_checkpoint: delegationCheckpoint,
      guidance: last.environment_error ? 'A possible environment/tool execution error was observed, not evidence against the challenge hypothesis. Check whether the diagnostic is an actual execution error rather than quoted input. Do not repeat the unchanged denied or malformed invocation; inspect the error and use an already working execution path within host permissions. Preserve any partial evidence. Do not change ACLs or disable host safeguards.'
        : stalled ? 'Different arguments produced identical visible output repeatedly. This is not proof of the same underlying behavior. Check complete saved evidence and the common premise; select a discriminating control or an independent approach instead of expanding variants blindly. Necessary repeated measurements remain valid; no call was blocked.'
        : last.failed ? 'Inspect actual failure evidence before choosing the next experiment. An environment error is not a refuted hypothesis.'
        : last.repeats ? 'Same tool arguments were used before. Reuse prior evidence if inputs and target state are unchanged; polling/revalidation may still be necessary. No call has been blocked.'
          : 'No failure, repetition or stagnation inferred from this observation. The coordination checkpoint is separate from the result verdict.',
    });
  }
}

export function registerExecutionFeedback(ctx) {
  const feedback = new ExecutionFeedback();
  ctx.on('tools/result', (exec, result) => feedback.observe(exec, result));
  ctx.systemPrompt.context({ name: 'ctf:execution-feedback', order: 910,
    text: assembly => feedback.render(assembly.agent) });
}
