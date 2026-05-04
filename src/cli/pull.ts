import type { Command } from 'commander';
import { wrap, type RunCtx } from '../lib/runner.js';
import { requireInitialized } from '../lib/gating.js';
import { pull } from '../lib/pull.js';
import { GrowthError } from '../lib/envelope.js';

export function registerPull(program: Command, ctx: RunCtx): void {
  program
    .command('pull <experiment_id>')
    .description('Idempotently pull events for an experiment from a connector.')
    .requiredOption('--source <name>', 'Connector source name, for example posthog.')
    .option('--after <iso>', 'Lower bound timestamp; defaults to last highwater - 1min or 24h ago.')
    .option('--before <iso>', 'Upper bound timestamp; defaults to now.')
    .option('--limit <n>', 'Per-event-name page size cap.', (v) => parseInt(v, 10))
    .action(
      async (
        experimentId: string,
        opts: { source: string; after?: string; before?: string; limit?: number },
      ) => {
        await wrap('growth pull', ctx, async () => {
          await requireInitialized(ctx.getRoot());
          if (!opts.source) {
            throw new GrowthError('missing_source', 'pull requires --source <name>.');
          }
          const result = await pull(ctx.getRoot(), {
            experimentId,
            source: opts.source,
            after: opts.after,
            before: opts.before,
            limit: opts.limit,
            allowOverlap: ctx.assumeYes(),
          });
          return {
            data: result,
            humanText: [
              `Pulled ${experimentId} from ${result.source} window ${result.window.after} -> ${result.window.before}`,
              `  raw: ${result.raw_fetched}  emitted: ${result.emitted}  deduped: ${result.deduped}`,
              `  dropped: ${result.dropped.map((d) => `${d.reason}=${d.count}`).join(', ') || 'none'}`,
            ].join('\n'),
            nextSteps: [`growth analyze ${experimentId} --json`],
          };
        });
      },
    );
}
