import type { Command } from 'commander';
import { promises as fs } from 'node:fs';
import { wrap, type RunCtx } from '../lib/runner.js';
import { requireInitialized } from '../lib/gating.js';
import { Store } from '../lib/store.js';
import { GrowthError } from '../lib/envelope.js';
import { applyTemplate } from '../domain/builder.js';
import { requiredSampleSize } from '../domain/stats.js';
import type { Experiment } from '../domain/types.js';

interface CreateFlags {
  template?: string;
  fromFile?: string;
  fromJson?: string;
  name?: string;
  hypothesis?: string;
  owner?: string;
  baseline?: number;
  mde?: number;
  maxDays?: number;
}

async function buildFromFlags(store: Store, id: string, flags: CreateFlags): Promise<Experiment> {
  const haveSource = !!(flags.template || flags.fromFile || flags.fromJson);
  if (!haveSource) {
    throw new GrowthError(
      'missing_source',
      'experiment create needs one of --template, --from-file, or --from-json.',
    );
  }

  if (flags.fromJson || flags.fromFile) {
    const raw = flags.fromJson ?? (await fs.readFile(flags.fromFile!, 'utf8'));
    const exp = JSON.parse(raw) as Experiment;
    exp.id = id;
    if (!exp.created_at) exp.created_at = new Date().toISOString();
    exp.updated_at = new Date().toISOString();
    if (!exp.status) exp.status = 'draft';
    if (!exp.sample_size.per_variant) {
      exp.sample_size.per_variant = requiredSampleSize(
        exp.sample_size.baseline_rate,
        exp.sample_size.minimum_detectable_effect,
        exp.sample_size.power,
        exp.sample_size.alpha,
      );
    }
    return exp;
  }

  const template = await store.getTemplate(flags.template!);
  if (!template) {
    throw new GrowthError(
      'template_not_found',
      `Template "${flags.template}" not found. Run \`growth template list --json\`.`,
    );
  }
  return applyTemplate(template, {
    id,
    name: flags.name,
    hypothesis: flags.hypothesis,
    owner: flags.owner,
    baseline_rate: flags.baseline,
    minimum_detectable_effect: flags.mde,
    max_duration_days: flags.maxDays,
  });
}

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
    .action(async (id: string, opts: CreateFlags) => {
      await wrap('growth experiment create', ctx, async () => {
        await requireInitialized(ctx.getRoot());
        const store = new Store(ctx.getRoot());
        const existing = await store.getExperiment(id);
        if (existing) {
          throw new GrowthError('already_exists', `Experiment "${id}" already exists.`);
        }
        const exp = await buildFromFlags(store, id, opts);
        await store.saveExperiment(exp);
        return {
          data: { experiment: exp },
          humanText: `Created experiment ${exp.id} (${exp.status}).`,
          nextSteps: [
            `growth experiment show ${exp.id} --json`,
            `growth instrumentation plan ${exp.id} --json`,
            `growth preflight prepare ${exp.id} --agents 4 --browser --json`,
          ],
          next: {
            command: `growth instrumentation plan ${exp.id} --json`,
            until: 'instrumentation contract is ready for implementation',
          },
        };
      });
    });

  experiment
    .command('list')
    .description('List all experiments.')
    .action(async () => {
      await wrap('growth experiment list', ctx, async () => {
        await requireInitialized(ctx.getRoot());
        const store = new Store(ctx.getRoot());
        const experiments = await store.listExperiments();
        const summary = experiments.map((e) => ({
          id: e.id,
          name: e.name,
          status: e.status,
          variants: e.variants.length,
          metrics: e.metrics.length,
          started_at: e.started_at,
          stopped_at: e.stopped_at,
        }));
        return {
          data: { experiments: summary },
          humanText:
            summary.length === 0
              ? 'No experiments. Run `growth experiment create <id> --template <name>`.'
              : summary.map((s) => `  ${s.status.padEnd(10)} ${s.id.padEnd(40)} ${s.name}`).join('\n'),
        };
      });
    });

  experiment
    .command('show <id>')
    .description('Print one experiment spec in full.')
    .action(async (id: string) => {
      await wrap('growth experiment show', ctx, async () => {
        await requireInitialized(ctx.getRoot());
        const store = new Store(ctx.getRoot());
        const exp = await store.getExperiment(id);
        if (!exp) throw new GrowthError('not_found', `Experiment "${id}" not found.`);
        return {
          data: { experiment: exp },
          humanText: JSON.stringify(exp, null, 2),
        };
      });
    });

  experiment
    .command('update <id>')
    .description('Replace an experiment config from JSON.')
    .requiredOption('--from-json <json>', 'Inline JSON spec.')
    .action(async (id: string, opts: { fromJson: string }) => {
      await wrap('growth experiment update', ctx, async () => {
        await requireInitialized(ctx.getRoot());
        const store = new Store(ctx.getRoot());
        const existing = await store.getExperiment(id);
        if (!existing) throw new GrowthError('not_found', `Experiment "${id}" not found.`);
        const next = JSON.parse(opts.fromJson) as Experiment;
        next.id = id;
        next.created_at = existing.created_at;
        next.updated_at = new Date().toISOString();
        await store.saveExperiment(next);
        return {
          data: { experiment: next },
          humanText: `Updated experiment ${id}.`,
          nextSteps: [`growth experiment show ${id} --json`, `growth validate --json`],
        };
      });
    });

  experiment
    .command('start <id>')
    .description('Mark an experiment as running.')
    .action(async (id: string) => {
      await wrap('growth experiment start', ctx, async () => {
        await requireInitialized(ctx.getRoot());
        const store = new Store(ctx.getRoot());
        const exp = await store.getExperiment(id);
        if (!exp) throw new GrowthError('not_found', `Experiment "${id}" not found.`);
        if (exp.status === 'running') {
          return {
            data: { experiment: exp, changed: false },
            humanText: `Experiment ${id} is already running.`,
          };
        }
        exp.status = 'running';
        const now = new Date().toISOString();
        exp.started_at = exp.started_at ?? now;
        exp.updated_at = now;
        await store.saveExperiment(exp);
        return {
          data: { experiment: exp, changed: true },
          humanText: `Started experiment ${id} at ${exp.started_at}.`,
          nextSteps: [
            `growth instrumentation verify ${id} --json`,
            `growth pull ${id} --source <name> --after <iso> --json`,
            `growth analyze ${id} --segment real-users --json`,
          ],
        };
      });
    });

  experiment
    .command('stop <id>')
    .description('Mark an experiment as stopped.')
    .option('--reason <text>', 'Why was it stopped?')
    .action(async (id: string, opts: { reason?: string }) => {
      await wrap('growth experiment stop', ctx, async () => {
        await requireInitialized(ctx.getRoot());
        const store = new Store(ctx.getRoot());
        const exp = await store.getExperiment(id);
        if (!exp) throw new GrowthError('not_found', `Experiment "${id}" not found.`);
        if (exp.status === 'stopped' || exp.status === 'completed') {
          return {
            data: { experiment: exp, changed: false },
            humanText: `Experiment ${id} is already ${exp.status}.`,
          };
        }
        exp.status = 'stopped';
        const now = new Date().toISOString();
        exp.stopped_at = now;
        exp.updated_at = now;
        if (opts.reason) exp.stop_reason = opts.reason;
        await store.saveExperiment(exp);
        return {
          data: { experiment: exp, changed: true },
          humanText: `Stopped experiment ${id} at ${exp.stopped_at}.`,
        };
      });
    });

  experiment
    .command('archive <id>')
    .description('Archive an experiment.')
    .action(async (id: string) => {
      await wrap('growth experiment archive', ctx, async () => {
        await requireInitialized(ctx.getRoot());
        const store = new Store(ctx.getRoot());
        const exp = await store.getExperiment(id);
        if (!exp) throw new GrowthError('not_found', `Experiment "${id}" not found.`);
        exp.status = 'archived';
        exp.updated_at = new Date().toISOString();
        await store.saveExperiment(exp);
        return {
          data: { experiment: exp, changed: true },
          humanText: `Archived experiment ${id}.`,
        };
      });
    });
}
