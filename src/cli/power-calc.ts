import type { Command } from 'commander';
import { wrap, type RunCtx } from '../lib/runner.js';
import { requiredSampleSize } from '../core/experiment/stats.js';

export function registerPowerCalc(program: Command, ctx: RunCtx): void {
  program
    .command('power-calc')
    .description('Compute required per-variant sample size for an A/B test.')
    .requiredOption('--baseline <rate>', 'Baseline rate (0..1).', parseFloat)
    .requiredOption('--mde <effect>', 'Minimum detectable relative effect (e.g., 0.15).', parseFloat)
    .option('--power <p>', 'Statistical power.', parseFloat, 0.8)
    .option('--alpha <a>', 'Significance level.', parseFloat, 0.05)
    .option('--daily <n>', 'Daily traffic per variant; if set, returns days needed.', (v) =>
      parseInt(v, 10),
    )
    .option('--daily-traffic <n>', 'Daily traffic per variant; alias for --daily.', (v) =>
      parseInt(v, 10),
    )
    .action(
      async (opts: {
        baseline: number;
        mde: number;
        power: number;
        alpha: number;
        daily?: number;
        dailyTraffic?: number;
      }) => {
        await wrap('growth power-calc', ctx, async () => {
          const n = requiredSampleSize(opts.baseline, opts.mde, opts.power, opts.alpha);
          const daily = opts.dailyTraffic ?? opts.daily;
          const days = daily ? Math.ceil(n / daily) : undefined;
          return {
            data: {
              per_variant: n,
              total: n * 2,
              estimated_days: days,
              inputs: opts,
            },
            humanText: [
              `Required sample size: ${n} per variant (${n * 2} total).`,
              days ? `At ${daily} daily/variant, ${days} day(s) to reach significance.` : '',
            ]
              .filter(Boolean)
              .join('\n'),
          };
        });
      },
    );
}
