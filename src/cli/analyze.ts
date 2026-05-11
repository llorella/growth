import type { Command } from 'commander';
import { wrap, type RunCtx } from '../lib/runner.js';
import { requireInitialized } from '../lib/gating.js';
import { Store } from '../lib/store.js';
import { GrowthError } from '../lib/envelope.js';
import { analyzeExperiment } from '../domain/analyze.js';
import type { AnalysisSegment } from '../domain/types.js';
import { readShared, writeShared } from '../lib/state.js';

const SEGMENTS = new Set(['all', 'real-users', 'agent-generated']);

export function registerAnalyze(program: Command, ctx: RunCtx): void {
  program
    .command('analyze <id>')
    .description('Run statistical analysis and produce a conservative recommendation.')
    .option('--segment <name>', 'all, real-users, or agent-generated.', 'real-users')
    .action(async (id: string, opts: { segment: AnalysisSegment }) => {
      await wrap('growth analyze', ctx, async () => {
        await requireInitialized(ctx.getRoot());
        if (!SEGMENTS.has(opts.segment)) {
          throw new GrowthError('invalid_segment', `Unknown segment "${opts.segment}".`, {
            available: Array.from(SEGMENTS),
          });
        }
        const store = new Store(ctx.getRoot());
        const exp = await store.getExperiment(id);
        if (!exp) throw new GrowthError('not_found', `Experiment "${id}" not found.`);
        const result = await analyzeExperiment(store, exp, opts.segment);
        const shared = await readShared(ctx.getRoot());
        if (shared?.experiments[id]) {
          shared.experiments[id].last_analysis_at = result.generated_at;
          await writeShared(ctx.getRoot(), shared);
        }
        return {
          data: result,
          humanText: [
            `Experiment ${id} (${result.status}, ${result.runtime_days}d, ${result.total_users} users, segment=${result.segment})`,
            '',
            `  Recommendation: ${result.recommendation.action} (${result.recommendation.confidence})`,
            `  ${result.recommendation.reasoning}`,
          ].join('\n'),
          nextSteps: result.recommendation.next_steps,
        };
      });
    });
}
