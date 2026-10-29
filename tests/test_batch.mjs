import test from 'node:test';
import assert from 'node:assert/strict';
import { executeBatch, strictPwsh } from '../plugins/batch-core.mjs';

function host(fail = false) {
  const calls = [];
  const ctx = { tools: {
    executionMode: ({ name }) => ({ kind: name === 'read' ? 'parallel' : 'exclusive' }),
    execute: async input => {
      calls.push(input);
      return { isError: fail && input.name === 'read', content: [{ type: 'text', text: 'observed' }] };
    },
  } };
  return { ctx, calls };
}
const execution = () => ({ agent: { id: 'test' }, token: {}, callId: 'outer', signal: new AbortController().signal });
test('every nested call preserves host agent, token, cancellation and archive write', async () => {
  const { ctx, calls } = host(); const exec = execution();
  const value = await executeBatch(ctx, { steps: [{ tool: 'read', args: { file_path: 'a' } },
    { tool: 'read', args: { file_path: 'b' } }], output_path: 'results.json', parallel_reads: true }, exec);
  assert.equal(value.completed, 2); assert.equal(value.archive_written, true);
  assert.equal(calls.at(-1).name, 'write');
  for (const call of calls) { assert.equal(call.agent, exec.agent); assert.equal(call.parent, exec.token); assert.equal(call.signal, exec.signal); }
});
test('failure stops later work but preserves evidence', async () => {
  const { ctx, calls } = host(true);
  const value = await executeBatch(ctx, { steps: [{ tool: 'read', args: {} },
    { tool: 'pwsh', args: { command: 'echo should-not-run' } }], output_path: 'result.json' }, execution());
  assert.equal(value.skipped, 1); assert.equal(value.errors, 1);
  assert.deepEqual(calls.map(x => x.name), ['read', 'write']);
});
test('PowerShell errors become terminating, native exit code is propagated', () => {
  const value = strictPwsh({ command: 'python solve.py', description: 'test' });
  assert.match(value.command, /ErrorActionPreference='Stop'/); assert.match(value.command, /exit \$LASTEXITCODE/);
  assert.equal(value.description, 'test');
});
test('batch recursion rejected', async () => {
  await assert.rejects(executeBatch(host().ctx, { steps: [{ tool: 'ctf_batch', args: {} }], output_path: 'x' }, execution()));
});
