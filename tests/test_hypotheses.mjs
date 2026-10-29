import test from 'node:test';
import assert from 'node:assert/strict';
import { Hypotheses } from '../plugins/hypotheses.mjs';
const exec = id => ({ agent: { id }, signal: new AbortController().signal, token: {}, callId: id });
const host = fail => ({ tools: { execute: async () => ({ isError: !!fail }) } });
const args = () => ({ case_key: 'fixture', action: 'update', expected_revision: 0,
  id: 'h1', statement: 'test condition', status: 'refuted', observation: 'actual counterexample',
  evidence: ['evidence.txt'], output_path: 'fixture/evidence' });
test('shared evidence reaches bound teammate, unrelated agent sees nothing', async () => {
  const s = new Hypotheses(); await s.execute(host(), args(), exec('lead'));
  assert.equal(s.render({ id: 'other' }), '');
  await s.execute(host(), { case_key: 'fixture', action: 'list' }, exec('worker'));
  assert.match(s.render({ id: 'worker' }), /refuted/);
});
test('concurrent stale updates cannot overwrite each other', async () => {
  const s = new Hypotheses(); const r = await Promise.allSettled([
    s.execute(host(), args(), exec('a')), s.execute(host(), args(), exec('b'))]);
  assert.equal(r.filter(x => x.status === 'fulfilled').length, 1);
  assert.equal(s.states.get('fixture').revision, 1);
});
test('failed snapshot does not advance revision or bind state', async () => {
  const s = new Hypotheses(); await assert.rejects(s.execute(host(true), args(), exec('a')));
  assert.equal(s.states.size, 0); assert.equal(s.render({ id: 'a' }), '');
});
test('evidence required for semantic status, and history retained', async () => {
  const s = new Hypotheses(); await assert.rejects(s.execute(host(), { ...args(), evidence: [] }, exec('a')));
  await s.execute(host(), args(), exec('a'));
  await s.execute(host(), { ...args(), expected_revision: 1, status: 'unknown' }, exec('a'));
  assert.equal(s.states.get('fixture').hypotheses.h1.history[0].status, 'refuted');
});
test('context is bounded and cases remain separate', async () => {
  const s = new Hypotheses(); await s.execute(host(), { ...args(), observation: 'x'.repeat(10000) }, exec('a'));
  await s.execute(host(), { case_key: 'new', action: 'list' }, exec('b'));
  assert.equal(s.render({ id: 'b' }), ''); assert.ok(s.render({ id: 'a' }).length < 2100);
});
