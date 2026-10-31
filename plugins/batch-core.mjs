// Preset-scoped tool. Nested calls use the HOST execution pipeline, not raw tool bodies.
import { randomUUID } from 'node:crypto';
export const REVISION = '0.7.3';

export function strictPwsh(args) {
  return { ...args, command: "$ErrorActionPreference='Stop'; $global:LASTEXITCODE=0;\n" +
    args.command + '\nif ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }' };
}

function compact(result) {
  const code = result.value?.exitCode ?? result.value?.exit_code;
  return { is_error: result.isError === true || (typeof code === 'number' && code !== 0),
    exit_code: typeof code === 'number' ? code : null,
    content: result.content ?? [], error: result.error?.message ?? null };
}

// A preview is not a complete observation. Never silently discard evidence.
export function previewText(content, budget = 12000) {
  const text = content.filter(c => c.type === 'text').map(c => c.text).join('\n');
  const truncated = text.length > budget;
  return { preview: truncated ? text.slice(0, budget * 3 / 4) +
    '\n[OMITTED: read full archive before excluding a hypothesis]\n' + text.slice(-budget / 4) : text,
    total_chars: text.length, truncated };
}

export async function executeBatch(ctx, args, exec) {
  if (!Array.isArray(args.steps) || !args.steps.length || typeof args.output_path !== 'string') {
    throw new Error('steps and output_path are required');
  }
  for (const step of args.steps) {
    if (typeof step.tool !== 'string' || step.tool === 'ctf_batch' ||
        !step.args || typeof step.args !== 'object' || Array.isArray(step.args)) {
      throw new Error('each step needs a nonrecursive tool name and argument object');
    }
  }
  const results = [];
  let sequence = 0;
  const call = (name, parameters) => ctx.tools.execute({
    name, arguments: parameters, agent: exec.agent, signal: exec.signal,
    parent: exec.token, callId: `${exec.callId}:ctf:${++sequence}`,
    rootCallId: exec.rootCallId ?? exec.callId,
  });
  async function run(step, index) {
    exec.signal.throwIfAborted();
    const start = performance.now();
    const parameters = step.tool === 'pwsh' ? strictPwsh(step.args) : step.args;
    const value = compact(await call(step.tool, parameters));
    return { index, tool: step.tool, elapsed_ms: Math.round(performance.now() - start), ...value };
  }
  // Mutating/exclusive tools remain serial. Only host-declared concurrency-safe
  // calls may overlap, and only when the caller explicitly requests parallel reads.
  let pending = [];
  async function settle() {
    if (pending.length) results.push(...await Promise.all(pending));
    pending = [];
    return args.stop_on_error !== false && results.some(x => x.is_error);
  }
  for (let index = 0; index < args.steps.length; index++) {
    const step = args.steps[index];
    const safe = args.parallel_reads === true && ctx.tools.executionMode({
      name: step.tool, arguments: step.args, agent: exec.agent,
    }).kind === 'parallel';
    if (safe) {
      pending.push(run(step, index));
      if (pending.length >= 4 && await settle()) break;
    } else {
      if (await settle()) break;
      results.push(await run(step, index));
      if (args.stop_on_error !== false && results.at(-1).is_error) break;
    }
  }
  await settle();
  results.sort((a, b) => a.index - b.index);
  const archivePath = `${args.output_path}.${randomUUID()}.json`;
  const archive = compact(await call('write', {
    file_path: archivePath,
    content: JSON.stringify({ revision: REVISION, results, skipped: args.steps.length - results.length }, null, 2),
  }));
  const summary = { revision: REVISION, completed: results.length, skipped: args.steps.length - results.length,
    errors: results.filter(x => x.is_error).length, archive_written: !archive.is_error,
    archive_path: archivePath, archive_error: archive.error,
    results: results.map(x => ({ index: x.index, tool: x.tool, is_error: x.is_error,
      exit_code: x.exit_code, elapsed_ms: x.elapsed_ms,
      ...previewText(x.content, Math.floor(12000 / results.length)) })) };
  return summary;
}

