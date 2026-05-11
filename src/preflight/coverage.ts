import type { Experiment } from '../domain/types.js';
import type { PacketScenario } from './types.js';

export interface PreflightCoverage {
  required_events: string[];
  primary_metric_events: string[];
  guardrail_metric_events: string[];
  scenarios: PacketScenario[];
}

export function preflightCoverage(exp: Experiment): PreflightCoverage {
  const requiredEvents = requiredPreflightEvents(exp);
  const primaryMetricEvents = uniqueEvents(
    exp.metrics.filter((metric) => metric.role === 'primary').flatMap(metricEvents),
  );
  const guardrailMetricEvents = uniqueEvents(
    exp.metrics.filter((metric) => metric.role === 'guardrail').flatMap(metricEvents),
  );

  return {
    required_events: requiredEvents,
    primary_metric_events: primaryMetricEvents,
    guardrail_metric_events: guardrailMetricEvents,
    scenarios: configuredScenarios(exp) ?? inferredScenarios(exp, {
      required_events: requiredEvents,
      guardrail_metric_events: guardrailMetricEvents,
    }),
  };
}

export function selectCoverageScenario(exp: Experiment, index: number): PacketScenario {
  const coverage = preflightCoverage(exp);
  return coverage.scenarios[index % coverage.scenarios.length];
}

export function scenarioExpectedEvents(exp: Experiment, scenario: PacketScenario): string[] {
  return scenario.expected_events ?? preflightCoverage(exp).required_events;
}

export function requiredPreflightEvents(exp: Experiment): string[] {
  const out = new Set<string>();
  for (const metric of exp.metrics) {
    for (const event of metricEvents(metric)) out.add(event);
  }
  for (const event of exp.instrumentation?.events ?? []) out.add(event.event);
  return Array.from(out).sort();
}

export function metricEvents(metric: Experiment['metrics'][number]): string[] {
  return metric.denominator_event ? [metric.denominator_event, metric.event] : [metric.event];
}

export function uniqueEvents(values: string[]): string[] {
  return Array.from(new Set(values)).sort();
}

function configuredScenarios(exp: Experiment): PacketScenario[] | null {
  const configured = exp.preflight?.scenarios ?? [];
  if (configured.length === 0) return null;
  return configured.map((scenario) => ({
    id: scenario.id,
    goal: scenario.goal,
    instructions: scenario.instructions ?? [
      'Use the product naturally for this scenario.',
      'Report blockers and list any expected events you could not naturally exercise.',
    ],
    expected_events: scenario.expected_events,
  }));
}

function inferredScenarios(
  exp: Experiment,
  coverage: Pick<PreflightCoverage, 'required_events' | 'guardrail_metric_events'>,
): PacketScenario[] {
  const primary = exp.metrics.find((metric) => metric.role === 'primary') ?? exp.metrics[0];
  const scenarios: PacketScenario[] = [
    {
      id: 'primary_metric_path',
      goal: primary
        ? `Exercise the user path that would naturally emit primary metric "${primary.id}" (${primary.event}).`
        : 'Exercise the most obvious product path controlled by this experiment.',
      instructions: [
        'Use the product naturally within the visible UI.',
        'Try to reach the outcome described by the experiment hypothesis and primary metric.',
        'If the path is unavailable or unclear, report the blocker instead of inventing a route.',
      ],
      expected_events: primary ? metricEvents(primary) : coverage.required_events,
    },
  ];

  if (coverage.guardrail_metric_events.length) {
    scenarios.push({
      id: 'guardrail_metric_observation',
      goal: 'Observe whether any declared guardrail condition appears during realistic product use.',
      instructions: [
        `Declared guardrail events: ${coverage.guardrail_metric_events.join(', ')}.`,
        'Use only safe, reversible actions available in the UI.',
        'Do not force destructive behavior; list unreachable guardrail events in missing_expected_events.',
      ],
      expected_events: coverage.guardrail_metric_events,
    });
  }

  const covered = new Set(scenarios.flatMap((scenario) => scenario.expected_events ?? []));
  const remaining = coverage.required_events.filter((event) => !covered.has(event));
  if (remaining.length) {
    scenarios.push({
      id: 'declared_event_surface',
      goal: 'Explore adjacent product paths that may emit remaining declared events.',
      instructions: [
        `Remaining declared events: ${remaining.join(', ')}.`,
        'Stay within the browser UI and behave like a normal user.',
        'List any events you could not naturally exercise in missing_expected_events.',
      ],
      expected_events: remaining,
    });
  }

  return scenarios;
}
