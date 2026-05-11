import type { Experiment, GrowthRun } from '../domain/types.js';
import type { PacketScenario } from './types.js';

const BASE_PACKET_PROMPT = `You are acting as a realistic user of this product.

Use only the browser tool specified in your packet. Do not inspect source code,
localStorage, network logs, analytics dashboards, repository files, environment
variables, or implementation details. Do not modify files.

Open the provided URL. Follow the scenario in this packet. Make your own choices
where the product gives multiple plausible paths. Stop when the scenario is
complete or when you are genuinely stuck.

Return a structured report matching the provided schema.
`;

export function packetVariant(
  variantIds: string[],
  index: number,
  opts: { forceVariant?: string; balanceVariants: boolean },
): string | undefined {
  if (opts.forceVariant) return opts.forceVariant;
  if (opts.balanceVariants === false) return undefined;
  return variantIds[index % variantIds.length];
}

export function packetScenario(exp: Experiment, index: number): PacketScenario {
  const configured = exp.preflight?.scenarios ?? [];
  const scenarios = configured.length
    ? configured.map((scenario) => ({
        id: scenario.id,
        goal: scenario.goal,
        instructions: scenario.instructions ?? [
          'Use the product naturally for this scenario.',
          'Report blockers and list any expected events you could not naturally exercise.',
        ],
        expected_events: scenario.expected_events,
      }))
    : inferredScenarios(exp);
  return scenarios[index % scenarios.length];
}

function inferredScenarios(exp: Experiment): PacketScenario[] {
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
      expected_events: primary ? metricEvents(primary) : expectedEvents(exp),
    },
  ];
  const guardrails = exp.metrics.filter((metric) => metric.role === 'guardrail');
  if (guardrails.length) {
    scenarios.push({
      id: 'guardrail_metric_observation',
      goal: 'Observe whether any declared guardrail condition appears during realistic product use.',
      instructions: [
        `Declared guardrail events: ${unique(guardrails.flatMap(metricEvents)).join(', ')}.`,
        'Use only safe, reversible actions available in the UI.',
        'Do not force destructive behavior; list unreachable guardrail events in missing_expected_events.',
      ],
      expected_events: unique(guardrails.flatMap(metricEvents)),
    });
  }
  const covered = new Set(scenarios.flatMap((scenario) => scenario.expected_events ?? []));
  const remaining = expectedEvents(exp).filter((event) => !covered.has(event));
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

export function metricEvents(metric: Experiment['metrics'][number]): string[] {
  return metric.denominator_event ? [metric.denominator_event, metric.event] : [metric.event];
}

export function unique(values: string[]): string[] {
  return Array.from(new Set(values)).sort();
}

export function packetPrompt(exp: Experiment, scenario: PacketScenario): string {
  return [
    BASE_PACKET_PROMPT.trimEnd(),
    '',
    `Experiment: ${exp.id}`,
    `Scenario: ${scenario.id}`,
    `Goal: ${scenario.goal}`,
    '',
    'Scenario instructions:',
    ...scenario.instructions.map((instruction) => `- ${instruction}`),
    '',
    'Expected event surface for your report:',
    ...(scenario.expected_events ?? expectedEvents(exp)).map((event) => `- ${event}`),
    '',
    'If you cannot naturally exercise an expected event, list it in missing_expected_events.',
    '',
  ].join('\n');
}

export function expectedEvents(exp: Experiment): string[] {
  const out = new Set<string>();
  for (const metric of exp.metrics) {
    out.add(metric.event);
    if (metric.denominator_event) out.add(metric.denominator_event);
  }
  for (const event of exp.instrumentation?.events ?? []) out.add(event.event);
  return Array.from(out).sort();
}

export function buildAgentUrl(appUrl: string, experimentId: string, agentRunId: string, variantId?: string): string {
  const url = new URL(appUrl);
  url.searchParams.set('agent_generated', 'true');
  url.searchParams.set('agent_run_id', agentRunId);
  url.searchParams.set('experiment_id', experimentId);
  if (variantId) url.searchParams.set('variant', variantId);
  return url.toString();
}

export function launchManual(run: GrowthRun): string {
  return [
    `# ${run.id}`,
    '',
    `Experiment: ${run.experiment_id ?? '(none)'}`,
    '',
    'Launch each packet with a browser-capable agent. The agent may only use the URL, prompt, policy, and report schema in its packet.',
    '',
    ...(run.agents ?? []).map(
      (agent, i) =>
        `${i + 1}. ${agent.agent_id}\n   - URL: ${agent.url_file}\n   - Prompt: ${agent.prompt_file}\n   - Policy: ${agent.policy_file}\n   - Report schema: ${agent.report_schema_file}`,
    ),
    '',
  ].join('\n');
}

