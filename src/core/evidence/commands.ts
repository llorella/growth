import { GrowthError } from '../../lib/envelope.js';
import { pull } from '../../lib/pull.js';
import { Store } from '../../lib/store.js';
import { simulateExperiment } from './simulate.js';

export interface SimulateExperimentCommandOptions {
  days: number;
  daily: number;
  lift: number;
  seed?: string;
  persist?: boolean;
  clear?: boolean;
  allowClear?: boolean;
}

export async function simulateExperimentCommand(
  root: string,
  id: string,
  opts: SimulateExperimentCommandOptions,
) {
  if (opts.clear && !opts.allowClear) {
    throw new GrowthError('confirmation_required', 'Pass --yes with --clear to replace existing experiment data.');
  }
  const store = new Store(root);
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
    nextSteps: opts.persist === false ? [] : [`growth preflight plan ${id} --json`],
  };
}

export interface PullExperimentCommandOptions {
  source: string;
  after?: string;
  before?: string;
  limit?: number;
  allowOverlap?: boolean;
}

export async function pullExperimentCommand(
  root: string,
  experimentId: string,
  opts: PullExperimentCommandOptions,
) {
  if (!opts.source) {
    throw new GrowthError('missing_source', 'pull requires --source <name>.');
  }
  const result = await pull(root, {
    experimentId,
    source: opts.source,
    after: opts.after,
    before: opts.before,
    limit: opts.limit,
    allowOverlap: opts.allowOverlap === true,
  });
  return {
    data: result,
    humanText: [
      `Pulled ${experimentId} from ${result.source} window ${result.window.after} -> ${result.window.before}`,
      `  raw: ${result.raw_fetched}  emitted: ${result.emitted}  deduped: ${result.deduped}`,
      `  dropped: ${result.dropped.map((d) => `${d.reason}=${d.count}`).join(', ') || 'none'}`,
    ].join('\n'),
    nextSteps: [`growth preflight plan ${experimentId} --json`],
  };
}
