import type { Command } from 'commander';
import { wrap, type RunCtx } from '../lib/runner.js';
import { requireInitialized } from '../lib/gating.js';
import {
  simulateExperimentCommand,
  type SimulateExperimentCommandOptions,
} from '../core/evidence/commands.js';

export function registerSimulate(program: Command, ctx: RunCtx): void {
  program
    .command('simulate <id>')
    .description('Generate synthetic data and persist to the store.')
    .option('--days <n>', 'Days of synthetic data.', (v) => parseInt(v, 10), 14)
    .option('--daily <n>', 'Daily traffic.', (v) => parseInt(v, 10), 200)
    .option('--lift <n>', 'True relative lift on the primary metric for treatment.', parseFloat, 0.1)
    .option('--seed <s>', 'PRNG seed (default: experiment id).')
    .option('--no-persist', 'Compute results but do not write to the store.')
    .option('--clear', 'Clear existing experiment data before writing simulation output.', false)
    .action(
      async (
        id: string,
        opts: Omit<SimulateExperimentCommandOptions, 'allowClear'>,
      ) => {
        await wrap('growth simulate', ctx, async () => {
          const root = ctx.getRoot();
          await requireInitialized(root);
          return simulateExperimentCommand(root, id, {
            ...opts,
            allowClear: ctx.assumeYes(),
          });
        });
      },
    );
}
