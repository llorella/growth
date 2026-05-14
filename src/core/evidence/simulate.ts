import { createHash } from 'node:crypto';
import { assignVariant } from '../experiment/assignment.js';
import {
  syntheticSimulationRunId,
  syntheticTrafficPayload,
} from './synthetic-traffic.js';
import type { Store } from '../../lib/store.js';
import type { Assignment, Experiment, ExperimentEvent } from '../experiment/types.js';

export interface SimulateOptions {
  days: number;
  dailyTraffic: number;
  trueLiftByVariant?: Record<string, number>;
  baselineRateByMetric?: Record<string, number>;
  liftByMetric?: Record<string, number>;
  seed?: string;
  persist?: boolean;
  clear?: boolean;
}

export interface SimulateResult {
  experiment_id: string;
  users_simulated: number;
  events_emitted: number;
  per_variant: Record<string, { users: number }>;
}

export async function simulateExperiment(
  store: Store,
  experiment: Experiment,
  opts: SimulateOptions,
): Promise<SimulateResult> {
  const seed = opts.seed ?? experiment.id;
  const syntheticRunId = syntheticSimulationRunId(seed);
  const rng = makeRng(seed);
  const persist = opts.persist !== false;

  const startTime = Date.now() - opts.days * 24 * 60 * 60 * 1000;
  if (persist) {
    experiment.started_at = new Date(startTime).toISOString();
    experiment.status = 'running';
    experiment.updated_at = new Date().toISOString();
    await store.saveExperiment(experiment);
  }

  const expBaseline = experiment.sample_size.baseline_rate;

  const baselineFor = (m: { id: string; role: string; type: string }): number => {
    if (opts.baselineRateByMetric?.[m.id] !== undefined) return opts.baselineRateByMetric[m.id];
    if (m.type === 'continuous') return 30;
    if (m.role === 'primary') return expBaseline;
    if (m.role === 'guardrail') return 0.03;
    return expBaseline * 0.7;
  };

  const assignments: Assignment[] = [];
  const events: ExperimentEvent[] = [];
  const perVariant: Record<string, { users: number }> = {};
  for (const v of experiment.variants) perVariant[v.id] = { users: 0 };

  const orderedMetrics = topologicalOrder(experiment.metrics);
  const producedEvents = new Set(experiment.metrics.map((m) => m.event));
  const universalDenoms = new Set<string>();
  for (const m of experiment.metrics) {
    if (m.denominator_event && !producedEvents.has(m.denominator_event)) {
      universalDenoms.add(m.denominator_event);
    }
  }

  let totalUsers = 0;
  for (let day = 0; day < opts.days; day++) {
    const dayJitter = 0.85 + rng() * 0.3;
    const todaysUsers = Math.round(opts.dailyTraffic * dayJitter);

    for (let i = 0; i < todaysUsers; i++) {
      const userId = `sim_${seed}_${day}_${i}`;
      const variant = assignVariant(experiment.id, userId, experiment.variants);
      const tsBase = startTime + day * 86_400_000 + Math.floor(rng() * 86_400_000);

      assignments.push({
        experiment_id: experiment.id,
        user_id: userId,
        variant_id: variant.id,
        assigned_at: new Date(tsBase).toISOString(),
        source: 'simulate',
        context: syntheticTrafficPayload(syntheticRunId),
      });
      perVariant[variant.id].users += 1;
      totalUsers += 1;

      const userFiredEvents = new Set<string>();

      for (const denomEvent of universalDenoms) {
        events.push({
          experiment_id: experiment.id,
          user_id: userId,
          variant_id: variant.id,
          event: denomEvent,
          timestamp: new Date(tsBase + 1000).toISOString(),
          source: 'simulate',
          payload: syntheticTrafficPayload(syntheticRunId),
        });
        userFiredEvents.add(denomEvent);
      }

      for (const m of orderedMetrics) {
        if (m.denominator_event && !userFiredEvents.has(m.denominator_event)) continue;

        const isControl = variant.id === experiment.variants[0].id;
        const variantLift = opts.trueLiftByVariant?.[variant.id] ?? 0;
        const lift = isControl
          ? 0
          : opts.liftByMetric?.[m.id] !== undefined
            ? opts.liftByMetric[m.id]
            : m.role === 'primary'
              ? variantLift
              : m.role === 'secondary'
                ? variantLift * 0.5
                : 0;

        const baseline = baselineFor(m);

        if (m.type === 'proportion') {
          const rate = clamp01(baseline * (1 + lift));
          if (rng() < rate) {
            events.push({
              experiment_id: experiment.id,
              user_id: userId,
              variant_id: variant.id,
              event: m.event,
              timestamp: new Date(
                tsBase + 60_000 + Math.floor(rng() * 600_000),
              ).toISOString(),
              source: 'simulate',
              payload: syntheticTrafficPayload(syntheticRunId),
            });
            userFiredEvents.add(m.event);
          }
        } else if (m.type === 'continuous') {
          const magnitude = baseline > 1 ? baseline : 1;
          const base = magnitude * (0.7 + rng() * 0.6);
          const value = base * (1 + lift);
          events.push({
            experiment_id: experiment.id,
            user_id: userId,
            variant_id: variant.id,
            event: m.event,
            timestamp: new Date(tsBase + 60_000).toISOString(),
            source: 'simulate',
            payload: {
              ...(m.value_field ? { [m.value_field]: value } : { value }),
              ...syntheticTrafficPayload(syntheticRunId),
            },
          });
          userFiredEvents.add(m.event);
        } else {
          const expected = 1 + lift;
          const count = Math.max(0, Math.round(expected + (rng() - 0.5)));
          for (let k = 0; k < count; k++) {
            events.push({
              experiment_id: experiment.id,
              user_id: userId,
              variant_id: variant.id,
              event: m.event,
              timestamp: new Date(tsBase + 60_000 + k * 1000).toISOString(),
              source: 'simulate',
              payload: syntheticTrafficPayload(syntheticRunId),
            });
          }
          if (count > 0) userFiredEvents.add(m.event);
        }
      }
    }
  }

  if (persist && opts.clear) {
    await store.clearData(experiment.id);
  }
  if (persist) {
    for (const a of assignments) await store.appendAssignment(a);
    if (events.length) await store.appendEvents(events);
  }

  return {
    experiment_id: experiment.id,
    users_simulated: totalUsers,
    events_emitted: events.length,
    per_variant: perVariant,
  };
}

function clamp01(x: number): number {
  return Math.max(0, Math.min(1, x));
}

function topologicalOrder<T extends { event: string; denominator_event?: string }>(
  metrics: T[],
): T[] {
  const byEvent = new Map<string, T>();
  for (const m of metrics) byEvent.set(m.event, m);
  const visited = new Set<string>();
  const out: T[] = [];

  const visit = (m: T, stack: Set<string>) => {
    if (visited.has(m.event)) return;
    if (stack.has(m.event)) return;
    stack.add(m.event);
    if (m.denominator_event && byEvent.has(m.denominator_event)) {
      visit(byEvent.get(m.denominator_event)!, stack);
    }
    stack.delete(m.event);
    visited.add(m.event);
    out.push(m);
  };
  for (const m of metrics) visit(m, new Set());
  return out;
}

function makeRng(seed: string): () => number {
  const hash = createHash('sha256').update(seed).digest();
  let state = hash.readUInt32BE(0);
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
