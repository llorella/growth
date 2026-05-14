import type { Command } from 'commander';
import { wrap, type RunCtx } from '../lib/runner.js';
import { requireInitialized } from '../lib/gating.js';
import { analyzeExperimentCommand } from '../core/analysis/commands.js';
import type { AnalysisSegment } from '../core/experiment/types.js';

export function registerAnalyze(program: Command, ctx: RunCtx): void {
  program
    .command('analyze <id>')
    .description('Run statistical analysis and produce a conservative recommendation.')
    .option('--segment <name>', 'all, real-users, or agent-generated.', 'real-users')
    .action(async (id: string, opts: { segment: AnalysisSegment }) => {
      await wrap('growth analyze', ctx, async () => {
        const root = ctx.getRoot();
        await requireInitialized(root);
        return analyzeExperimentCommand(root, id, opts.segment);
      });
    });
}
