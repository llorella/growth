import type { Experiment, GrowthRun } from '../domain/types.js';
import { buildSyntheticTrafficUrl } from '../domain/synthetic-traffic.js';
import type { PacketScenario } from './types.js';
import {
  scenarioExpectedEvents,
  selectCoverageScenario,
} from './coverage.js';

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
  return selectCoverageScenario(exp, index);
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
    ...scenarioExpectedEvents(exp, scenario).map((event) => `- ${event}`),
    '',
    'If you cannot naturally exercise an expected event, list it in missing_expected_events.',
    '',
  ].join('\n');
}

export function buildAgentUrl(appUrl: string, experimentId: string, agentRunId: string, variantId?: string): string {
  return buildSyntheticTrafficUrl(appUrl, experimentId, agentRunId, variantId);
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
