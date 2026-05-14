import type {
  AnalysisResult,
  ComparisonResult,
  Experiment,
  ExperimentEvent,
  Metric,
  MetricAnalysis,
  Recommendation,
  AnalysisSegment,
  Assignment,
} from '../experiment/types.js';
import { continuousSignificance, proportionSignificance } from '../experiment/stats.js';
import { isRealUserEvent, isSyntheticEvent } from '../evidence/synthetic-traffic.js';

type RawValuesByVariant = Record<string, number[]>;

interface TrafficMix {
  total_events: number;
  synthetic_events: number;
  real_events: number;
}

export interface AnalysisEvidence {
  experiment: Experiment;
  events: ExperimentEvent[];
  assignments: Assignment[];
  segment?: AnalysisSegment;
  now?: Date;
}

export function buildAnalysis(evidence: AnalysisEvidence): AnalysisResult {
  const segment = evidence.segment ?? 'real-users';
  const now = evidence.now ?? new Date();
  const { experiment } = evidence;
  const events = filterEventsBySegment(evidence.events, segment);
  const trafficMix: TrafficMix = {
    total_events: events.length,
    synthetic_events: events.filter(isSyntheticEvent).length,
    real_events: events.filter(isRealUserEvent).length,
  };
  const syntheticOnly = events.length > 0 && events.every(isSyntheticEvent);
  const segmentUsers = new Set(events.map((e) => e.user_id));
  const assignments =
    segment === 'all'
      ? evidence.assignments
      : evidence.assignments.filter((a) => segmentUsers.has(a.user_id));

  const userVariant = new Map<string, string>();
  for (const a of assignments) userVariant.set(a.user_id, a.variant_id);

  const perVariant: Record<string, { users: number }> = {};
  for (const v of experiment.variants) perVariant[v.id] = { users: 0 };
  for (const [, vid] of userVariant) {
    if (perVariant[vid]) perVariant[vid].users += 1;
  }

  const metricAnalyses = experiment.metrics.map((m) =>
    analyzeMetric(m, experiment, events, userVariant),
  );

  const runtimeDays = experiment.started_at
    ? Math.max(
        0,
        Math.floor(
          (now.getTime() - new Date(experiment.started_at).getTime()) / (1000 * 60 * 60 * 24),
        ),
      )
    : 0;

  const totalUsers = Object.values(perVariant).reduce((s, v) => s + v.users, 0);

  return {
    experiment_id: experiment.id,
    status: experiment.status,
    runtime_days: runtimeDays,
    total_users: totalUsers,
    per_variant: perVariant,
    metrics: metricAnalyses,
    recommendation: makeRecommendation(
      experiment,
      metricAnalyses,
      runtimeDays,
      segment,
      syntheticOnly,
      trafficMix,
    ),
    generated_at: now.toISOString(),
    segment,
  };
}

function filterEventsBySegment(events: ExperimentEvent[], segment: AnalysisSegment): ExperimentEvent[] {
  if (segment === 'all') return events;
  if (segment === 'agent-generated') {
    return events.filter(isSyntheticEvent);
  }
  return events.filter(isRealUserEvent);
}

function analyzeMetric(
  metric: Metric,
  experiment: Experiment,
  events: ExperimentEvent[],
  userVariant: Map<string, string>,
): MetricAnalysis {
  const variants: MetricAnalysis['variants'] = {};
  for (const v of experiment.variants) {
    variants[v.id] = { n: 0 };
  }
  const rawByVariant: RawValuesByVariant = {};
  for (const v of experiment.variants) rawByVariant[v.id] = [];

  if (metric.type === 'proportion') {
    const numeratorUsers: Record<string, Set<string>> = {};
    const denominatorUsers: Record<string, Set<string>> = {};
    for (const v of experiment.variants) {
      numeratorUsers[v.id] = new Set();
      denominatorUsers[v.id] = new Set();
    }

    for (const e of events) {
      const vid = userVariant.get(e.user_id) ?? e.variant_id;
      if (!variants[vid]) continue;
      if (e.event === metric.event) numeratorUsers[vid].add(e.user_id);
      if (metric.denominator_event && e.event === metric.denominator_event) {
        denominatorUsers[vid].add(e.user_id);
      }
    }

    for (const v of experiment.variants) {
      const n = metric.denominator_event
        ? denominatorUsers[v.id].size
        : Array.from(userVariant.values()).filter((x) => x === v.id).length;
      const successes = numeratorUsers[v.id].size;
      variants[v.id] = {
        n,
        successes,
        rate: n > 0 ? successes / n : 0,
      };
    }
  } else if (metric.type === 'continuous') {
    const valuesByVariant: Record<string, number[]> = {};
    for (const v of experiment.variants) valuesByVariant[v.id] = [];

    for (const e of events) {
      if (e.event !== metric.event) continue;
      const vid = userVariant.get(e.user_id) ?? e.variant_id;
      if (!valuesByVariant[vid]) continue;
      const raw = metric.value_field
        ? (e.payload?.[metric.value_field] as number | undefined)
        : 1;
      if (typeof raw === 'number' && !Number.isNaN(raw)) valuesByVariant[vid].push(raw);
    }

    for (const v of experiment.variants) {
      const vals = valuesByVariant[v.id];
      const sum = vals.reduce((s, x) => s + x, 0);
      variants[v.id] = {
        n: vals.length,
        sum,
        mean: vals.length > 0 ? sum / vals.length : 0,
      };
      rawByVariant[v.id] = vals;
    }
  } else {
    const counts: Record<string, number> = {};
    const userCounts: Record<string, Set<string>> = {};
    for (const v of experiment.variants) {
      counts[v.id] = 0;
      userCounts[v.id] = new Set();
    }
    for (const e of events) {
      if (e.event !== metric.event) continue;
      const vid = userVariant.get(e.user_id) ?? e.variant_id;
      if (counts[vid] === undefined) continue;
      counts[vid] += 1;
      userCounts[vid].add(e.user_id);
    }
    for (const v of experiment.variants) {
      variants[v.id] = { n: userCounts[v.id].size, sum: counts[v.id] };
    }
  }

  const control = experiment.variants[0];
  const comparisons: ComparisonResult[] = experiment.variants
    .filter((v) => v.id !== control.id)
    .map((v) => compareToControl(metric, control.id, v.id, variants, experiment, rawByVariant));

  return {
    metric_id: metric.id,
    metric_name: metric.name,
    role: metric.role,
    type: metric.type,
    direction: metric.direction,
    variants,
    comparisons,
  };
}

function compareToControl(
  metric: Metric,
  controlId: string,
  variantId: string,
  variants: MetricAnalysis['variants'],
  experiment: Experiment,
  rawByVariant: RawValuesByVariant,
): ComparisonResult {
  const c = variants[controlId];
  const v = variants[variantId];
  const alpha = experiment.sample_size.alpha;
  const minPerVariant = Math.max(30, experiment.sample_size.per_variant ?? 30);

  if (metric.type === 'proportion') {
    const sig = proportionSignificance(
      c.n,
      c.successes ?? 0,
      v.n,
      v.successes ?? 0,
      alpha,
      minPerVariant,
    );
    return {
      variant_id: variantId,
      baseline_id: controlId,
      absolute_diff: sig.absoluteDiff,
      relative_lift: sig.relativeLift,
      p_value: sig.pValue,
      confidence_interval_95: sig.ci95,
      significant: sig.status === 'significant',
      status: sig.status,
    };
  }

  if (metric.type === 'continuous') {
    const cVals = rawByVariant[controlId] ?? [];
    const tVals = rawByVariant[variantId] ?? [];
    const sig = continuousSignificance(cVals, tVals, alpha, minPerVariant);
    return {
      variant_id: variantId,
      baseline_id: controlId,
      absolute_diff: sig.absoluteDiff,
      relative_lift: sig.percentChange,
      p_value: sig.pValue,
      confidence_interval_95: sig.ci95,
      significant: sig.status === 'significant',
      status: sig.status,
    };
  }

  if (metric.type === 'count') {
    if ((c.n ?? 0) < minPerVariant || (v.n ?? 0) < minPerVariant) {
      return {
        variant_id: variantId,
        baseline_id: controlId,
        absolute_diff: (v.sum ?? 0) / Math.max(1, v.n) - (c.sum ?? 0) / Math.max(1, c.n),
        relative_lift: 0,
        p_value: NaN,
        confidence_interval_95: { lower: NaN, upper: NaN },
        significant: false,
        status: 'insufficient_data',
      };
    }
    const cMean = (c.sum ?? 0) / Math.max(1, c.n);
    const vMean = (v.sum ?? 0) / Math.max(1, v.n);
    return {
      variant_id: variantId,
      baseline_id: controlId,
      absolute_diff: vMean - cMean,
      relative_lift: cMean ? (vMean - cMean) / cMean : 0,
      p_value: NaN,
      confidence_interval_95: { lower: NaN, upper: NaN },
      significant: false,
      status: 'not_significant',
    };
  }

  return {
    variant_id: variantId,
    baseline_id: controlId,
    absolute_diff: 0,
    relative_lift: 0,
    p_value: NaN,
    confidence_interval_95: { lower: NaN, upper: NaN },
    significant: false,
    status: 'not_significant',
  };
}

function makeRecommendation(
  experiment: Experiment,
  metrics: MetricAnalysis[],
  runtimeDays: number,
  segment: AnalysisSegment,
  syntheticOnly: boolean,
  trafficMix: TrafficMix,
): Recommendation {
  if (segment === 'agent-generated' || syntheticOnly) {
    return {
      action: 'synthetic_only_no_ship',
      confidence: 'high',
      reasoning:
        'Only agent-generated synthetic traffic is being analyzed. Use this to validate instrumentation and UX, not to make a production ship decision.',
      next_steps: [
        'Start the experiment for real users.',
        'Keep monitoring guardrails.',
        'Use preflight reports for qualitative UX issues.',
      ],
    };
  }

  if (segment === 'all' && trafficMix.synthetic_events > 0 && trafficMix.real_events > 0) {
    return {
      action: 'keep_running',
      confidence: 'low',
      reasoning:
        'Analysis includes mixed real-user and agent-generated synthetic traffic. Re-run with --segment real-users before making any ship decision.',
      next_steps: [
        'Run growth analyze <experiment_id> --segment real-users --json.',
        'Use growth analyze <experiment_id> --segment agent-generated --json only for preflight and instrumentation checks.',
      ],
    };
  }

  const primary = metrics.find((m) => m.role === 'primary');
  const guardrails = metrics.filter((m) => m.role === 'guardrail');
  const minRuntime = experiment.auto_stop?.min_runtime_days ?? 7;

  let warning: string | undefined;
  for (const g of guardrails) {
    const metricDef = experiment.metrics.find((m) => m.id === g.metric_id);
    const threshold = metricDef?.guardrail_threshold ?? 0.1;
    for (const c of g.comparisons) {
      const adverseLift =
        g.direction === 'higher_is_better' ? c.relative_lift < 0 : c.relative_lift > 0;
      if (!adverseLift) continue;

      if (c.status === 'significant') {
        return {
          action: 'guardrail_breach',
          confidence: 'high',
          reasoning: `Guardrail "${g.metric_name}" moved adversely by ${(c.relative_lift * 100).toFixed(1)}% (significant, p=${c.p_value.toFixed(4)}).`,
          next_steps: [
            'Stop the experiment immediately.',
            'Investigate whether the change introduced the regression.',
            'Re-design before re-running.',
          ],
        };
      }

      const exceedsThreshold = Math.abs(c.relative_lift) >= threshold;
      const trending = !Number.isNaN(c.p_value) && c.p_value < 0.2;
      if (exceedsThreshold && trending && !warning) {
        warning = `Guardrail "${g.metric_name}" trending ${(c.relative_lift * 100).toFixed(1)}% adverse (p=${c.p_value.toFixed(4)}, threshold ${(threshold * 100).toFixed(0)}%) - watch closely.`;
      }
    }
  }

  if (!primary) {
    return {
      action: 'keep_running',
      confidence: 'low',
      reasoning: 'No primary metric defined. Add one to make ship decisions.',
      next_steps: ['Add a metric with role: primary to the experiment config.'],
    };
  }

  const primaryComparison = primary.comparisons[0];
  if (!primaryComparison) {
    return {
      action: 'keep_running',
      confidence: 'low',
      reasoning: 'Need at least one treatment variant to compare against control.',
      next_steps: ['Verify variants array has both control and at least one treatment.'],
    };
  }

  if (primaryComparison.status === 'insufficient_data') {
    const minPerVariant = Math.max(30, experiment.sample_size.per_variant ?? 30);
    return {
      action: 'keep_running',
      confidence: 'low',
      reasoning: `Need at least ${minPerVariant} users per variant. Currently ${
        primary.variants[experiment.variants[0].id].n
      } / ${primary.variants[primaryComparison.variant_id].n}.`,
      next_steps: [
        `Continue running. Required sample size per variant: ${minPerVariant}.`,
      ],
    };
  }

  const wantHigher = primary.direction === 'higher_is_better';
  const winning = wantHigher
    ? primaryComparison.relative_lift > 0
    : primaryComparison.relative_lift < 0;

  if (primaryComparison.status === 'significant' && winning && runtimeDays >= minRuntime) {
    const baseReasoning = `Primary metric moved ${(primaryComparison.relative_lift * 100).toFixed(1)}% in the desired direction with p=${primaryComparison.p_value.toFixed(4)}. Min runtime (${minRuntime}d) met.`;
    return {
      action: 'ship_treatment',
      confidence: warning ? 'medium' : 'high',
      reasoning: warning ? `${baseReasoning} Warning: ${warning}` : baseReasoning,
      next_steps: warning
        ? [
            'Investigate the trending guardrail before flipping treatment to 100%.',
            'If guardrail movement is noise (small denominator), document and ship.',
            'Otherwise iterate on the treatment to protect the guardrail.',
          ]
        : [
            'Roll out the treatment to 100%.',
            'Document the win in the experiment log.',
            'Identify the next experiment in the funnel.',
          ],
    };
  }

  if (primaryComparison.status === 'significant' && winning && runtimeDays < minRuntime) {
    return {
      action: 'keep_running',
      confidence: 'medium',
      reasoning: `Primary metric is significant (lift ${(primaryComparison.relative_lift * 100).toFixed(1)}%, p=${primaryComparison.p_value.toFixed(4)}) but min runtime (${minRuntime}d) not yet met. Wait to capture weekly seasonality before shipping.`,
      next_steps: [
        `Continue running for ${minRuntime - runtimeDays} more day(s).`,
        'Monitor guardrails for any regression.',
      ],
    };
  }

  if (primaryComparison.status === 'significant' && !winning) {
    return {
      action: 'rollback',
      confidence: 'high',
      reasoning: `Primary metric moved ${(primaryComparison.relative_lift * 100).toFixed(1)}% AGAINST the desired direction with p=${primaryComparison.p_value.toFixed(4)}.`,
      next_steps: [
        'Stop the experiment.',
        'Roll back the treatment.',
        'Form a new hypothesis or refine the implementation.',
      ],
    };
  }

  if (runtimeDays >= experiment.schedule.max_duration_days) {
    return {
      action: 'stop_inconclusive',
      confidence: 'medium',
      reasoning: `Hit max duration (${experiment.schedule.max_duration_days}d) without significance. Lift estimate: ${(primaryComparison.relative_lift * 100).toFixed(1)}%.`,
      next_steps: [
        'Stop the experiment.',
        'Either accept null result or design a stronger treatment with a larger expected effect.',
      ],
    };
  }

  return {
    action: 'keep_running',
    confidence: 'medium',
    reasoning: `Trending ${(primaryComparison.relative_lift * 100).toFixed(1)}% but not yet significant (p=${primaryComparison.p_value.toFixed(4)}).`,
    next_steps: [
      `Continue running until significance or day ${experiment.schedule.max_duration_days}.`,
    ],
  };
}
