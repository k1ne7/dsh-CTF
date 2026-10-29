import { executeBatch, REVISION } from './batch-core.mjs';
import { registerHypotheses } from './hypotheses.mjs';

export default class FastTools {
  static inject = ['tools', 'systemPrompt'];
  constructor(ctx) {
    registerHypotheses(ctx);
    ctx.tools.register({
      name: 'ctf_batch',
      description: `k1ne CTF ${REVISION}: execute several known native tool calls in ONE model turn; writes full results to output_path and returns short previews. All nested calls keep host approvals/sandbox. Use parallel_reads only for independent host-declared safe reads; writes/shell are serial. pwsh uses terminating errors and propagates the final native exit code. Stops after an error by default; inspect archive before retrying side effects.`,
      parameters: { type: 'object', additionalProperties: false, required: ['steps', 'output_path'], properties: {
        steps: { type: 'array', minItems: 1, items: { type: 'object', additionalProperties: false,
          required: ['tool', 'args'], properties: { tool: { type: 'string' },
            args: { type: 'object', additionalProperties: true } } } },
        output_path: { type: 'string', description: 'Archive filename prefix INSIDE the challenge workspace; a unique suffix is appended to avoid overwrites.' },
        parallel_reads: { type: 'boolean' }, stop_on_error: { type: 'boolean' },
      } },
      output: { schema: { type: 'object', additionalProperties: true },
        render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
      execute: (args, exec) => executeBatch(ctx, args, exec),
    });
  }
}
