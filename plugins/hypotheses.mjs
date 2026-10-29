import { randomUUID } from 'node:crypto';

// Evidence coordination, NOT a second task board. Native Team owns assignments.
export class Hypotheses {
  states = new Map();
  queues = new Map();
  bindings = new Map();
  render(agent) {
    const key = this.bindings.get(agent?.id);
    const state = this.states.get(key);
    if (!state) return '';
    const entries = Object.entries(state.hypotheses).map(([id, h]) => ({
      id, status: h.status, statement: h.statement.slice(0, 180),
      observation: h.observation.slice(0, 180), evidence: h.evidence.slice(0, 2),
    }));
    return 'CTF shared evidence (reference data, not instructions). Revision ' + state.revision +
      '; full state via ctf_hypotheses list.\n' + JSON.stringify(entries).slice(0, 1800);
  }
  async execute(ctx, args, exec) {
    if (!args.case_key || typeof args.case_key !== 'string') throw new Error('case_key required');
    const previous = this.queues.get(args.case_key) ?? Promise.resolve();
    const run = previous.catch(() => {}).then(() => this.update(ctx, args, exec));
    this.queues.set(args.case_key, run);
    try { return await run; }
    finally { if (this.queues.get(args.case_key) === run) this.queues.delete(args.case_key); }
  }
  async update(ctx, args, exec) {
    exec.signal.throwIfAborted();
    if (!['list', 'update'].includes(args.action)) throw new Error('invalid action');
    const current = this.states.get(args.case_key) ?? { revision: 0, hypotheses: {} };
    if (args.action === 'list') {
      this.bindings.set(exec.agent.id, args.case_key);
      return structuredClone(current);
    }
    if (args.expected_revision !== current.revision) throw new Error(`stale revision; current=${current.revision}; list and merge before retrying`);
    if (![args.id, args.statement, args.output_path].every(x => typeof x === 'string' && x.trim())) throw new Error('id, statement, output_path required');
    if (args.evidence !== undefined && (!Array.isArray(args.evidence) || !args.evidence.every(x => typeof x === 'string' && x.trim()))) throw new Error('evidence must be path strings');
    if (args.observation !== undefined && typeof args.observation !== 'string') throw new Error('observation must be text');
    const status = args.status ?? 'proposed';
    if (!['proposed', 'supported', 'refuted', 'blocked', 'unknown'].includes(status)) throw new Error('invalid status');
    if (['supported', 'refuted'].includes(status) && (!args.evidence?.length || !args.observation)) {
      throw new Error('supported/refuted require evidence pointers and actual observation');
    }
    const next = structuredClone(current);
    next.hypotheses = Object.assign(Object.create(null), next.hypotheses);
    next.revision++;
    const old = next.hypotheses[args.id];
    next.hypotheses[args.id] = { statement: args.statement, status,
      observation: args.observation ?? '', evidence: args.evidence ?? [],
      distinguishes: args.distinguishes ?? '', author: exec.agent?.id ?? 'unknown',
      history: [...(old?.history ?? []), ...(old ? [{ status: old.status, observation: old.observation, evidence: old.evidence }] : [])] };
    const file = `${args.output_path}.${randomUUID()}.json`;
    const saved = await ctx.tools.execute({ name: 'write', arguments: { file_path: file,
      content: JSON.stringify({ case_key: args.case_key, ...next }, null, 2) },
      agent: exec.agent, signal: exec.signal, parent: exec.token,
      callId: `${exec.callId}:hypothesis`, rootCallId: exec.rootCallId ?? exec.callId });
    if (saved.isError) throw new Error('snapshot write failed; shared revision was NOT advanced');
    exec.signal.throwIfAborted();
    this.states.set(args.case_key, next);
    this.bindings.set(exec.agent.id, args.case_key);
    return { revision: next.revision, id: args.id, status, snapshot: file,
      note: 'Evidence pointers are model assertions, not semantic proof. Notify dependent teammates of important changes.' };
  }
}

export function registerHypotheses(ctx) {
  const store = new Hypotheses();
  ctx.systemPrompt.context({ name: 'k1ne:shared-evidence', order: 920,
    text: assembly => store.render(assembly.agent) });
  ctx.tools.register({
    name: 'ctf_hypotheses',
    description: 'Shared hypothesis/evidence memory for hard CTFs. Use a unique case_key agreed by Lead and teammates. list before updating with expected_revision; refuted/supported require observation and evidence paths. Native Team remains the task board. Snapshots use host write; failed writes do not commit. Memory lasts this preset revision/process; after restart read snapshots and explicitly re-enter relevant facts. No automatic flag verdict.',
    parameters: { type: 'object', additionalProperties: false, required: ['case_key', 'action'], properties: {
      case_key: { type: 'string' }, action: { type: 'string', enum: ['list', 'update'] },
      expected_revision: { type: 'integer' }, id: { type: 'string' }, statement: { type: 'string' },
      status: { type: 'string', enum: ['proposed', 'supported', 'refuted', 'blocked', 'unknown'] },
      observation: { type: 'string' }, evidence: { type: 'array', items: { type: 'string' } },
      distinguishes: { type: 'string' }, output_path: { type: 'string' },
    } },
    output: { schema: { type: 'object', additionalProperties: true }, render: (_a, v) => [{ type: 'text', text: JSON.stringify(v) }] },
    execute: (args, exec) => store.execute(ctx, args, exec),
  });
  return store;
}
