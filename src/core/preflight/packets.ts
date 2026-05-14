import { promises as fs } from 'node:fs';
import path from 'node:path';
import { connectorAdapterFor } from '../../connectors/registry.js';
import { openEventWindow } from '../evidence/event-window.js';
import { preflightReportSchema } from '../experiment/schema.js';
import { buildSyntheticTrafficUrl } from '../evidence/synthetic-traffic.js';
import type { AgentPacketSummary, Experiment, GrowthRun } from '../experiment/types.js';
import { resolveAppUrl } from '../../lib/app-url.js';
import { listConnectors, type ConnectorConfig } from '../../lib/connectors.js';
import { GrowthError } from '../../lib/envelope.js';
import { paths } from '../../lib/paths.js';
import { readProjectProfile } from '../../lib/project-profile.js';
import { Store } from '../../lib/store.js';
import {
  scenarioExpectedEvents,
  selectCoverageScenario,
} from './coverage.js';
import { resolvePreflightPlan, withStartPath, type PreflightPlan } from './plan.js';
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

export interface PreflightPacketOptions {
  agents: number;
  browser: boolean;
  appUrl?: string;
  baseUrl?: string;
  forceVariant?: string;
  balanceVariants: boolean;
}

export interface PreflightPacketContext {
  exp: Experiment;
  framework: string;
  appUrl: string;
  plan: PreflightPlan;
}

export function planWarnings(plan: PreflightPlan) {
  const warnings = [];
  if (preferredEvidenceSource(plan)?.provider_backed === false) {
    warnings.push({
      code: 'LOCAL_EVIDENCE_CEILING',
      message: 'Local JSONL can validate synthetic app emission only; it does not prove provider ingestion.',
    });
  }
  if (plan.browser_context.requires_authenticated_session) {
    warnings.push({
      code: 'AUTHENTICATED_BROWSER_CONTEXT',
      message:
        'Experiment targeting indicates an authenticated browser context. Browser packets need an authenticated test session and should report login/paywall blockers explicitly.',
    });
  }
  if (plan.target_route_source.kind === 'default_root') {
    warnings.push({
      code: 'TARGET_ROUTE_DEFAULT_ROOT',
      message:
        'No explicit target route is configured. Growth will use /; configure a project route or path-valued targeting domain when the experiment starts elsewhere.',
    });
  }
  return warnings;
}

export async function resolvePreflightPacketContext(
  root: string,
  experimentId: string,
  opts: Pick<PreflightPacketOptions, 'appUrl' | 'baseUrl' | 'forceVariant' | 'agents'>,
): Promise<PreflightPacketContext> {
  if (opts.appUrl && opts.baseUrl && opts.appUrl !== opts.baseUrl) {
    throw new GrowthError('conflicting_app_urls', '--app-url and --base-url were both provided with different values.');
  }
  const store = new Store(root);
  const exp = await store.getExperiment(experimentId);
  if (!exp) throw new GrowthError('not_found', `Experiment "${experimentId}" not found.`);
  const projectProfile = await readProjectProfile(root);
  const framework = projectProfile.framework?.id ?? 'unknown';
  const appUrl = await resolveAppUrl(root, framework, opts.appUrl ?? opts.baseUrl);
  const connectors = await listConnectors(root);
  const plan = await resolvePreflightPlan({
    root,
    experiment: exp,
    connectors,
    framework,
    projectProfile,
    appUrl,
  });
  if (opts.forceVariant && !exp.variants.some((variant) => variant.id === opts.forceVariant)) {
    throw new GrowthError('invalid_variant', `Variant "${opts.forceVariant}" is not part of ${experimentId}.`, {
      variants: exp.variants.map((variant) => variant.id),
    });
  }
  if (opts.agents < 1 || opts.agents > 50) {
    throw new GrowthError('invalid_agents', '--agents must be between 1 and 50.');
  }
  return { exp, framework, appUrl, plan };
}

export async function preparePreflightPackets(
  root: string,
  experimentId: string,
  opts: PreflightPacketOptions,
  resolved: PreflightPacketContext,
) {
  const { exp, framework, appUrl, plan } = resolved;
  const packetAppUrl = plan.packet_app_url;
  const p = paths(root);
  const runId = `preflight_${new Date().toISOString().replace(/[-:.]/g, '').replace('T', 'T').slice(0, 15)}Z`;
  const runDir = path.join(p.runsDir, runId);
  const packetDir = path.join(runDir, 'agent-packets');
  const reportsDir = path.join(runDir, 'reports');
  await fs.mkdir(packetDir, { recursive: true });
  await fs.mkdir(reportsDir, { recursive: true });
  await fs.writeFile(path.join(runDir, 'batch-start.txt'), new Date().toISOString() + '\n');

  const agents: AgentPacketSummary[] = [];
  for (let i = 1; i <= opts.agents; i++) {
    const agentId = `${runId}_agent_${i}`;
    const variantId = packetVariant(exp.variants.map((variant) => variant.id), i - 1, opts);
    const scenario = packetScenario(exp, i - 1);
    const variantPacketAppUrl = packetAppUrlForVariant(exp, plan, packetAppUrl, variantId);
    const url = buildAgentUrl(variantPacketAppUrl, experimentId, agentId, variantId);
    const base = `agent-${i}`;
    const promptFile = path.join(packetDir, `${base}.prompt.txt`);
    const policyFile = path.join(packetDir, `${base}.policy.json`);
    const schemaFile = path.join(packetDir, `${base}.report.schema.json`);
    const urlFile = path.join(packetDir, `${base}.url.txt`);
    await fs.writeFile(promptFile, packetPrompt(exp, scenario));
    await fs.writeFile(urlFile, url + '\n');
    await fs.writeFile(
      policyFile,
      JSON.stringify(
        {
          browser: opts.browser,
          synthetic_variant: variantId ?? null,
          may_read_source: false,
          may_read_env: false,
          may_modify_files: false,
          allowed_url: url,
          scenario,
          expected_events: scenarioExpectedEvents(exp, scenario),
          browser_context: plan.browser_context,
        },
        null,
        2,
      ) + '\n',
    );
    await fs.writeFile(schemaFile, JSON.stringify(preflightReportSchema, null, 2) + '\n');
    agents.push({
      agent_id: agentId,
      browser: opts.browser,
      url_file: path.relative(root, urlFile),
      prompt_file: path.relative(root, promptFile),
      report_schema_file: path.relative(root, schemaFile),
      policy_file: path.relative(root, policyFile),
      variant_id: variantId,
    });
  }

  const warnings = [];
  if (opts.forceVariant) {
    warnings.push({
      code: 'FORCED_VARIANT_TEST_MODE',
      message: 'Packet URLs force one variant. Use this only for instrumentation testing.',
    });
  } else if (opts.balanceVariants !== false) {
    warnings.push({
      code: 'BALANCED_SYNTHETIC_VARIANTS',
      message:
        'Packet URLs force round-robin variants so synthetic traffic can exercise every branch. This is browser-agent test traffic only.',
    });
  }
  warnings.push({
    code: 'EVENT_WINDOW_START',
    message:
      'Only events emitted at or after this preflight prepare time are included by growth preflight pull. Earlier instrumentation-test events are intentionally excluded.',
  });
  if (packetAppUrl !== appUrl) {
    warnings.push({
      code: 'TARGET_ROUTE_APPLIED',
      message: `Packet URLs use ${packetAppUrl} based on the experiment preflight target route.`,
    });
  }
  if (!opts.appUrl && !opts.baseUrl) {
    warnings.push({
      code: 'APP_URL_RESOLVED',
      message: `Using ${packetAppUrl} for packet URLs. Override with --app-url or --base-url when your dev server uses a different URL.`,
    });
  }
  if (exp.variants.some((variant) => variant.implementation?.app_url)) {
    warnings.push({
      code: 'VARIANT_IMPLEMENTATION_URLS',
      message:
        'One or more packet URLs may use variant implementation app_url metadata instead of the default packet app URL.',
    });
  }
  if (plan.browser_context.requires_authenticated_session) {
    warnings.push({
      code: 'AUTHENTICATED_BROWSER_CONTEXT',
      message:
        'Experiment targeting indicates an authenticated browser context. Run packets with an authenticated test session and report login/paywall blockers explicitly.',
    });
  }

  const createdAt = new Date().toISOString();
  const run: GrowthRun = {
    id: runId,
    type: 'preflight',
    experiment_id: experimentId,
    status: 'prepared',
    created_at: createdAt,
    event_window: openEventWindow(createdAt),
    agents,
    artifacts: {
      run_dir: path.relative(root, runDir),
      launch_manual: path.relative(root, path.join(runDir, 'launch.manual.md')),
    },
    warnings,
  };
  const eventWindowAfter = run.event_window?.after ?? run.created_at;
  await fs.writeFile(path.join(runDir, 'run.json'), JSON.stringify(run, null, 2) + '\n');
  await fs.writeFile(path.join(runDir, 'launch.manual.md'), launchManual(run));
  const afterPacketExecution = nextAfterPacketExecution(run, plan);
  return {
    data: {
      run,
      run_id: run.id,
      app_url: appUrl,
      packet_app_url: packetAppUrl,
      preflight_plan: plan,
      framework_hint: { detected: framework, advisory_only: true },
    },
    humanText: `Prepared preflight ${runId} with ${agents.length} agent packet(s).`,
    warnings: run.warnings,
    nextSteps: [
      `Packet app URL: ${packetAppUrl}. Override future runs with --app-url or --base-url.`,
      `Open ${path.relative(root, path.join(runDir, 'launch.manual.md'))}.`,
      `Events before ${eventWindowAfter} will not be included in preflight pulls.`,
      `Attach reports with growth preflight attach-report ${runId} --agent <n> --file <report.json> --json.`,
      ...afterPacketExecution.nextSteps,
    ],
    next: afterPacketExecution.next,
  };
}

export function preferredPullSource(connectors: ConnectorConfig[]): string | undefined {
  return (
    providerBackedConnector(connectors)?.source ??
    connectors.find((connector) => connectorAdapterFor(connector)?.evidenceSource === 'local_jsonl')?.source ??
    connectors[0]?.source
  );
}

export function providerBackedConnector(connectors: ConnectorConfig[]): ConnectorConfig | undefined {
  return connectors.find((connector) => connectorAdapterFor(connector)?.providerBacked === true);
}

function packetAppUrlForVariant(
  exp: Experiment,
  plan: PreflightPlan,
  defaultPacketAppUrl: string,
  variantId?: string,
): string {
  const implementationUrl = variantId
    ? exp.variants.find((variant) => variant.id === variantId)?.implementation?.app_url
    : undefined;
  return implementationUrl ? withStartPath(implementationUrl, plan.target_route) : defaultPacketAppUrl;
}

function nextAfterPacketExecution(run: GrowthRun, plan: PreflightPlan) {
  const preferredEvidence = preferredEvidenceSource(plan);
  if (plan.readiness.blocked.length && preferredEvidence?.provider_backed !== false) {
    return {
      nextSteps: [plan.next_command],
      next: {
        command: plan.next_command,
        until: 'blocked evidence setup is resolved',
      },
    };
  }
  if (preferredEvidence?.provider_backed) {
    return {
      nextSteps: [
        `Complete with growth preflight complete ${run.id} --json after reports are attached.`,
        'Growth will then pull provider-backed synthetic events before audit.',
      ],
      next: {
        command: `growth preflight complete ${run.id} --json`,
        until: 'browser-agent reports are attached and provider-backed events can be pulled',
      },
    };
  }
  return {
    nextSteps: [
      `If browser execution writes local JSONL, complete in one step with growth preflight complete-local ${run.id} --events-file <events.jsonl> --json.`,
      `Otherwise attach reports and complete with growth preflight complete ${run.id} --json.`,
    ],
    next: {
      command: `growth preflight complete-local ${run.id} --events-file <events.jsonl> --json`,
      until: 'synthetic browser events are attached and local launch-readiness audit is written',
    },
  };
}

function preferredEvidenceSource(plan: PreflightPlan): PreflightPlan['evidence']['available_sources'][number] | undefined {
  return plan.evidence.available_sources.find((source) => source.evidence_source === plan.evidence.preferred_evidence);
}
