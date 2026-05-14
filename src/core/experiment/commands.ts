import { promises as fs } from 'node:fs';
import { GrowthError } from '../../lib/envelope.js';
import { Store } from '../../lib/store.js';
import { applyTemplate } from './builder.js';
import { requiredSampleSize } from './stats.js';
import type { Experiment, VariantImplementation } from './types.js';

export interface CreateExperimentFlags {
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

export interface VariantImplementationFlags {
  variant: string;
  status?: string;
  branch?: string;
  worktree?: string;
  commit?: string;
  prUrl?: string;
  appUrl?: string;
}

const IMPLEMENTATION_STATUSES = ['planned', 'in_progress', 'ready', 'merged', 'abandoned'] as const;
type ImplementationStatus = (typeof IMPLEMENTATION_STATUSES)[number];

export async function createExperimentCommand(root: string, id: string, flags: CreateExperimentFlags) {
  const store = new Store(root);
  const existing = await store.getExperiment(id);
  if (existing) {
    throw new GrowthError('already_exists', `Experiment "${id}" already exists.`);
  }
  const exp = await buildFromFlags(store, id, flags);
  await store.saveExperiment(exp);
  return {
    data: { experiment: exp },
    humanText: `Created experiment ${exp.id} (${exp.status}).`,
    nextSteps: [
      `growth experiment show ${exp.id} --json`,
      `growth instrumentation plan ${exp.id} --json`,
      `growth preflight run ${exp.id} --agents 4 --browser --json`,
    ],
    next: {
      command: `growth instrumentation plan ${exp.id} --json`,
      until: 'instrumentation contract is ready for implementation',
    },
  };
}

export async function setVariantImplementationCommand(
  root: string,
  id: string,
  flags: VariantImplementationFlags,
) {
  const store = new Store(root);
  const exp = await requireExperiment(store, id);
  const variantIndex = exp.variants.findIndex((variant) => variant.id === flags.variant);
  if (variantIndex < 0) {
    throw new GrowthError('variant_not_found', `Variant "${flags.variant}" is not part of ${id}.`, {
      variants: exp.variants.map((variant) => variant.id),
    });
  }
  const metadata = implementationFromFlags(flags);
  if (Object.keys(metadata).length === 0) {
    throw new GrowthError('missing_implementation_metadata', 'Provide at least one implementation metadata option.');
  }
  exp.variants[variantIndex] = {
    ...exp.variants[variantIndex],
    implementation: {
      ...(exp.variants[variantIndex].implementation ?? {}),
      ...metadata,
    },
  };
  exp.updated_at = new Date().toISOString();
  await store.saveExperiment(exp);
  return {
    data: {
      experiment: exp,
      variant: exp.variants[variantIndex],
    },
    humanText: `Updated implementation metadata for ${id}/${flags.variant}.`,
    nextSteps: [
      `growth experiment show ${id} --json`,
      `growth preflight plan ${id} --json`,
    ],
  };
}

export async function listExperimentsCommand(root: string) {
  const store = new Store(root);
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
        ? 'No experiments. Run `growth schema experiment --json`, then create one with `growth experiment create <id> --from-file <spec.json>` or an explicit template.'
        : summary.map((s) => `  ${s.status.padEnd(10)} ${s.id.padEnd(40)} ${s.name}`).join('\n'),
  };
}

export async function showExperimentCommand(root: string, id: string) {
  const store = new Store(root);
  const exp = await requireExperiment(store, id);
  return {
    data: { experiment: exp },
    humanText: JSON.stringify(exp, null, 2),
  };
}

export interface UpdateExperimentFlags {
  fromJson?: string;
  fromFile?: string;
}

export async function updateExperimentCommand(root: string, id: string, opts: UpdateExperimentFlags) {
  const store = new Store(root);
  const existing = await requireExperiment(store, id);
  if (!opts.fromJson && !opts.fromFile) {
    throw new GrowthError(
      'missing_source',
      'experiment update needs one of --from-file or --from-json.',
    );
  }
  const raw = opts.fromJson ?? (await fs.readFile(opts.fromFile!, 'utf8'));
  const next = JSON.parse(raw) as Experiment;
  next.id = id;
  next.created_at = existing.created_at;
  next.updated_at = new Date().toISOString();
  await store.saveExperiment(next);
  return {
    data: { experiment: next },
    humanText: `Updated experiment ${id}.`,
    nextSteps: [`growth experiment show ${id} --json`, `growth validate --json`],
  };
}

export async function startExperimentCommand(root: string, id: string) {
  const store = new Store(root);
  const exp = await requireExperiment(store, id);
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
}

export async function stopExperimentCommand(root: string, id: string, opts: { reason?: string }) {
  const store = new Store(root);
  const exp = await requireExperiment(store, id);
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
}

export async function archiveExperimentCommand(root: string, id: string) {
  const store = new Store(root);
  const exp = await requireExperiment(store, id);
  exp.status = 'archived';
  exp.updated_at = new Date().toISOString();
  await store.saveExperiment(exp);
  return {
    data: { experiment: exp, changed: true },
    humanText: `Archived experiment ${id}.`,
  };
}

async function buildFromFlags(store: Store, id: string, flags: CreateExperimentFlags): Promise<Experiment> {
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

function implementationFromFlags(flags: VariantImplementationFlags): VariantImplementation {
  const metadata: VariantImplementation = {};
  if (flags.status !== undefined) {
    if (!IMPLEMENTATION_STATUSES.includes(flags.status as ImplementationStatus)) {
      throw new GrowthError('invalid_implementation_status', `Unsupported implementation status "${flags.status}".`, {
        supported: [...IMPLEMENTATION_STATUSES],
      });
    }
    metadata.status = flags.status as ImplementationStatus;
  }
  if (flags.branch !== undefined) metadata.branch = flags.branch;
  if (flags.worktree !== undefined) metadata.worktree_path = flags.worktree;
  if (flags.commit !== undefined) metadata.commit = flags.commit;
  if (flags.prUrl !== undefined) metadata.pr_url = flags.prUrl;
  if (flags.appUrl !== undefined) metadata.app_url = flags.appUrl;
  return metadata;
}

async function requireExperiment(store: Store, id: string): Promise<Experiment> {
  const exp = await store.getExperiment(id);
  if (!exp) throw new GrowthError('not_found', `Experiment "${id}" not found.`);
  return exp;
}
