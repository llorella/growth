import type { Command } from 'commander';
import { wrap, type RunCtx } from '../lib/runner.js';
import { requireInitialized } from '../lib/gating.js';
import {
  archiveExperimentCommand,
  createExperimentCommand,
  listExperimentsCommand,
  setVariantImplementationCommand,
  showExperimentCommand,
  startExperimentCommand,
  stopExperimentCommand,
  updateExperimentCommand,
  type CreateExperimentFlags,
  type UpdateExperimentFlags,
  type VariantImplementationFlags,
} from '../core/experiment/commands.js';

export function registerExperiments(program: Command, ctx: RunCtx): void {
  const experiment = program
    .command('experiment')
    .alias('experiments')
    .description('Create, inspect, and manage growth experiments.');

  experiment
    .command('create <id>')
    .description('Create an experiment from a template, file, or inline JSON.')
    .option('--template <name>', 'Template name (see `growth template list`).')
    .option('--from-file <path>', 'Path to JSON file matching the schema.')
    .option('--from-json <json>', 'Inline JSON spec.')
    .option('--name <name>', 'Override name.')
    .option('--hypothesis <text>', 'Override hypothesis.')
    .option('--owner <name>', 'Override owner.')
    .option('--baseline <rate>', 'Baseline rate (0..1).', parseFloat)
    .option('--mde <effect>', 'Minimum detectable effect (relative).', parseFloat)
    .option('--max-days <n>', 'Max duration in days.', (v) => parseInt(v, 10))
    .action(async (id: string, opts: CreateExperimentFlags) => {
      await wrap('growth experiment create', ctx, async () => {
        const root = ctx.getRoot();
        await requireInitialized(root);
        return createExperimentCommand(root, id, opts);
      });
    });

  experiment
    .command('implementation')
    .description('Manage concrete variant implementation metadata.')
    .command('set <id>')
    .requiredOption('--variant <id>', 'Variant id to annotate.')
    .option('--status <status>', 'planned, in_progress, ready, merged, or abandoned.')
    .option('--branch <name>', 'Git branch containing this variant implementation.')
    .option('--worktree <path>', 'Worktree path containing this variant implementation.')
    .option('--commit <sha>', 'Commit SHA for this variant implementation.')
    .option('--pr-url <url>', 'Pull request URL for this variant implementation.')
    .option('--app-url <url>', 'Browser URL for this variant implementation.')
    .action(async (id: string, opts: VariantImplementationFlags) => {
      await wrap('growth experiment implementation set', ctx, async () => {
        const root = ctx.getRoot();
        await requireInitialized(root);
        return setVariantImplementationCommand(root, id, opts);
      });
    });

  experiment
    .command('list')
    .description('List all experiments.')
    .action(async () => {
      await wrap('growth experiment list', ctx, async () => {
        const root = ctx.getRoot();
        await requireInitialized(root);
        return listExperimentsCommand(root);
      });
    });

  experiment
    .command('show <id>')
    .description('Print one experiment spec in full.')
    .action(async (id: string) => {
      await wrap('growth experiment show', ctx, async () => {
        const root = ctx.getRoot();
        await requireInitialized(root);
        return showExperimentCommand(root, id);
      });
    });

  experiment
    .command('update <id>')
    .description('Replace an experiment config from JSON.')
    .option('--from-file <path>', 'Path to JSON file matching the schema.')
    .option('--from-json <json>', 'Inline JSON spec.')
    .action(async (id: string, opts: UpdateExperimentFlags) => {
      await wrap('growth experiment update', ctx, async () => {
        const root = ctx.getRoot();
        await requireInitialized(root);
        return updateExperimentCommand(root, id, opts);
      });
    });

  experiment
    .command('start <id>')
    .description('Mark an experiment as running.')
    .action(async (id: string) => {
      await wrap('growth experiment start', ctx, async () => {
        const root = ctx.getRoot();
        await requireInitialized(root);
        return startExperimentCommand(root, id);
      });
    });

  experiment
    .command('stop <id>')
    .description('Mark an experiment as stopped.')
    .option('--reason <text>', 'Why was it stopped?')
    .action(async (id: string, opts: { reason?: string }) => {
      await wrap('growth experiment stop', ctx, async () => {
        const root = ctx.getRoot();
        await requireInitialized(root);
        return stopExperimentCommand(root, id, opts);
      });
    });

  experiment
    .command('archive <id>')
    .description('Archive an experiment.')
    .action(async (id: string) => {
      await wrap('growth experiment archive', ctx, async () => {
        const root = ctx.getRoot();
        await requireInitialized(root);
        return archiveExperimentCommand(root, id);
      });
    });
}
