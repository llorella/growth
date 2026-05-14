import type { Command } from 'commander';
import { wrap, type RunCtx } from '../lib/runner.js';
import { requireInitialized } from '../lib/gating.js';
import {
  pullExperimentCommand,
  type PullExperimentCommandOptions,
} from '../core/evidence/commands.js';

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
        opts: Omit<PullExperimentCommandOptions, 'allowOverlap'>,
      ) => {
        await wrap('growth pull', ctx, async () => {
          const root = ctx.getRoot();
          await requireInitialized(root);
          return pullExperimentCommand(root, experimentId, {
            ...opts,
            allowOverlap: ctx.assumeYes(),
          });
        });
      },
    );
}
