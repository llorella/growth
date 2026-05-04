import { requiredSampleSize } from './stats.js';
import type { Experiment, Variant } from './types.js';

export interface BuildExperimentInput {
  id: string;
  name: string;
  hypothesis: string;
  owner?: string;
  variants?: Variant[];
  metrics: Experiment['metrics'];
  targeting?: Experiment['targeting'];
  baseline_rate: number;
  minimum_detectable_effect: number;
  power?: number;
  alpha?: number;
  max_duration_days?: number;
  min_runtime_days?: number;
  domains?: string[];
  notes?: string;
  instrumentation?: Experiment['instrumentation'];
}

export function buildExperiment(input: BuildExperimentInput): Experiment {
  const power = input.power ?? 0.8;
  const alpha = input.alpha ?? 0.05;
  const variants: Variant[] = input.variants ?? [
    { id: 'control', name: 'Control', weight: 50 },
    { id: 'treatment', name: 'Treatment', weight: 50 },
  ];

  const perVariant = requiredSampleSize(
    input.baseline_rate,
    input.minimum_detectable_effect,
    power,
    alpha,
  );

  const now = new Date().toISOString();
  return {
    id: input.id,
    name: input.name,
    hypothesis: input.hypothesis,
    owner: input.owner,
    status: 'draft',
    variants,
    metrics: input.metrics,
    targeting: {
      rules: input.targeting?.rules ?? [],
      segments: input.targeting?.segments,
      domains: input.domains ?? input.targeting?.domains,
    },
    sample_size: {
      baseline_rate: input.baseline_rate,
      minimum_detectable_effect: input.minimum_detectable_effect,
      power,
      alpha,
      per_variant: perVariant,
    },
    schedule: {
      max_duration_days: input.max_duration_days ?? 30,
      min_runtime_days: input.min_runtime_days ?? 7,
    },
    auto_stop: {
      on_significance: true,
      on_guardrail_breach: true,
      min_runtime_days: input.min_runtime_days ?? 7,
    },
    instrumentation: input.instrumentation,
    notes: input.notes,
    created_at: now,
    updated_at: now,
  };
}

export function applyTemplate(
  template: Partial<Experiment>,
  overrides: Partial<BuildExperimentInput> & { id: string; hypothesis?: string; name?: string },
): Experiment {
  const tplSize = template.sample_size;
  return buildExperiment({
    id: overrides.id,
    name: overrides.name ?? template.name ?? overrides.id,
    hypothesis: overrides.hypothesis ?? template.hypothesis ?? 'TODO: state hypothesis',
    owner: overrides.owner ?? template.owner,
    variants: overrides.variants ?? template.variants,
    metrics: overrides.metrics ?? template.metrics ?? [],
    targeting: overrides.targeting ?? template.targeting,
    baseline_rate: overrides.baseline_rate ?? tplSize?.baseline_rate ?? 0.2,
    minimum_detectable_effect:
      overrides.minimum_detectable_effect ?? tplSize?.minimum_detectable_effect ?? 0.15,
    power: overrides.power ?? tplSize?.power,
    alpha: overrides.alpha ?? tplSize?.alpha,
    max_duration_days: overrides.max_duration_days ?? template.schedule?.max_duration_days,
    min_runtime_days: overrides.min_runtime_days ?? template.schedule?.min_runtime_days,
    domains: overrides.domains ?? template.targeting?.domains,
    notes: overrides.notes ?? template.notes,
    instrumentation: overrides.instrumentation ?? template.instrumentation,
  });
}
