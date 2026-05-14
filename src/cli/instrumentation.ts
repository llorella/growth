import type { Command } from 'commander';
import { wrap, type RunCtx } from '../lib/runner.js';
import { requireInitialized } from '../lib/gating.js';
import {
  listInstrumentationEvents,
  planInstrumentation,
  sampleInstrumentationEvents,
  verifyInstrumentation,
} from '../core/instrumentation/commands.js';

export function registerInstrumentation(program: Command, ctx: RunCtx): void {
  const instrumentation = program
    .command('instrumentation')
    .description('Plan and verify application instrumentation for experiments.');

  instrumentation
    .command('plan <experiment_id>')
    .description('Generate the instrumentation contract for an experiment.')
    .action(async (experimentId: string) => {
      await wrap('growth instrumentation plan', ctx, async () => {
        const root = ctx.getRoot();
        await requireInitialized(root);
        return planInstrumentation(root, experimentId);
      });
    });

  instrumentation
    .command('events <experiment_id>')
    .description('List required events for an experiment.')
    .action(async (experimentId: string) => {
      await wrap('growth instrumentation events', ctx, async () => {
        const root = ctx.getRoot();
        await requireInitialized(root);
        return listInstrumentationEvents(root, experimentId);
      });
    });

  instrumentation
    .command('sample <experiment_id>')
    .description('Generate sample event payloads for an experiment.')
    .action(async (experimentId: string) => {
      await wrap('growth instrumentation sample', ctx, async () => {
        const root = ctx.getRoot();
        await requireInitialized(root);
        return sampleInstrumentationEvents(root, experimentId);
      });
    });

  instrumentation
    .command('verify <experiment_id>')
    .description('Verify experiment instrumentation contracts, connector mappings, and optional emitted events.')
    .option('--endpoint <url>', 'POST sample events to a local event endpoint.')
    .option('--events-file <path>', 'Read actual app-emitted JSONL events and verify the required event contract.')
    .action(async (experimentId: string, opts: { endpoint?: string; eventsFile?: string }) => {
      await wrap('growth instrumentation verify', ctx, async () => {
        const root = ctx.getRoot();
        await requireInitialized(root);
        return verifyInstrumentation(root, experimentId, opts);
      });
    });
}
