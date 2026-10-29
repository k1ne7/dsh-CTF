// Structural reasoning only: no network access, code execution or exploit verdict.
export function analyzeChain(args) {
  if (!Array.isArray(args.edges) || typeof args.entry !== 'string' || typeof args.goal !== 'string') throw new Error('entry, goal and edges required');
  const allowed = [], excluded = [];
  for (const edge of args.edges) {
    if (!edge || typeof edge.from !== 'string' || typeof edge.to !== 'string') throw new Error('edge endpoints required');
    if (!['unknown', 'supported', 'refuted'].includes(edge.status ?? 'unknown')) throw new Error('invalid edge status');
    if (edge.status === 'refuted') {
      if (!Array.isArray(edge.evidence) || !edge.evidence.length) throw new Error('refuted edges require evidence references');
      excluded.push(edge);
    } else allowed.push(edge);
  }
  const outgoing = new Map();
  for (const edge of allowed) {
    if (!outgoing.has(edge.from)) outgoing.set(edge.from, []);
    outgoing.get(edge.from).push(edge);
  }
  // Linear BFS: record one shortest structural path, not exponential path enumeration.
  const parent = new Map([[args.entry, null]]), queue = [args.entry];
  for (let i = 0; i < queue.length; i++) for (const edge of outgoing.get(queue[i]) ?? []) {
    if (!parent.has(edge.to)) { parent.set(edge.to, edge); queue.push(edge.to); }
  }
  const reachable = parent.has(args.goal), path = [];
  if (reachable) {
    let node = args.goal;
    while (node !== args.entry) { const edge = parent.get(node); path.unshift(edge); node = edge.from; }
  }
  return { reachable, candidate_path: path, excluded,
    validation_needed: path.filter(x => x.status !== 'supported' || x.condition).map(x => ({
      from: x.from, to: x.to, condition: x.condition ?? 'verify this transition in the actual runtime',
    })),
    branch_points: queue.filter(x => (outgoing.get(x)?.length ?? 0) > 1),
    visited_nodes: parent.size,
    note: 'Shortest structural path only. Edge labels/evidence are supplied by the model; runtime constraints, types, visibility and side effects need independent verification. No flag or exploit success verdict.' };
}

export function registerChain(ctx) {
  ctx.tools.register({ name: 'ctf_chain',
    description: 'Find a shortest structural entry-to-goal path in an evidence-labelled graph. Useful for POP/data-flow/auth/protocol chains. Handles cycles and prunes explicitly refuted edges with evidence. Returns unresolved conditions and branch points; does not parse source or establish exploitability. Use before repeatedly enumerating long candidate chains in prose.',
    parameters: { type: 'object', additionalProperties: false, required: ['entry','goal','edges'], properties: {
      entry: { type: 'string' }, goal: { type: 'string' }, edges: { type: 'array', items: {
        type: 'object', required: ['from','to'], additionalProperties: false, properties: {
          from: { type: 'string' }, to: { type: 'string' }, condition: { type: 'string' },
          status: { type: 'string', enum: ['unknown','supported','refuted'] },
          evidence: { type: 'array', items: { type: 'string' } },
        },
      } },
    } },
    output: { schema: { type: 'object', additionalProperties: true }, render: (_a,v) => [{ type:'text', text:JSON.stringify(v) }] },
    isConcurrencySafe: () => true,
    execute: args => analyzeChain(args),
  });
}
