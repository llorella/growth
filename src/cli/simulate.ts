import type { Command } from 'commander';
import { wrap, type RunCtx } from '../lib/runner.js';
import { requireInitialized } from '../lib/gating.js';
import { Store } from '../lib/store.js';
import { GrowthError } from '../lib/envelope.js';
import { simulateExperiment } from '../domain/simulate.js';

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
        opts: { days: number; daily: number; lift: number; seed?: string; persist?: boolean; clear?: boolean },
      ) => {
        await wrap('growth simulate', ctx, async () => {
          await requireInitialized(ctx.getRoot());
          if (opts.clear && !ctx.assumeYes()) {
            throw new GrowthError('confirmation_required', 'Pass --yes with --clear to replace existing experiment data.');
          }
          const store = new Store(ctx.getRoot());
          const exp = await store.getExperiment(id);
          if (!exp) throw new GrowthError('not_found', `Experiment "${id}" not found.`);
          const treatment = exp.variants.find((v) => v.id !== exp.variants[0].id);
          const trueLiftByVariant: Record<string, number> = {};
          if (treatment) trueLiftByVariant[treatment.id] = opts.lift;
          const result = await simulateExperiment(store, exp, {
            days: opts.days,
            dailyTraffic: opts.daily,
            trueLiftByVariant,
            seed: opts.seed,
            persist: opts.persist !== false,
            clear: opts.clear === true,
          });
          return {
            data: result,
            humanText: [
              `Simulated ${result.users_simulated} users, ${result.events_emitted} events.`,
              ...Object.entries(result.per_variant).map(
                ([v, p]) => `  ${v}: ${p.users} users`,
              ),
            ].join('\n'),
            nextSteps: opts.persist === false ? [] : [`growth analyze ${id} --segment agent-generated --json`],
          };
        });
      },
    );
}
