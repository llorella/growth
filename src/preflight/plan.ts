import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { Experiment } from '../domain/types.js';
import { readEnvValue, readLocalEnv } from '../lib/env-files.js';
import { defaultAppUrlForFramework } from '../lib/app-url.js';
import { connectorApiKeyEnv } from '../lib/connector-catalog.js';
import { assertCoverage, type ConnectorConfig } from '../lib/connectors.js';

export type EvidenceSource = 'posthog' | 'local_jsonl';
export type ReadinessTier =
  | 'blocked'
  | 'static_ready'
  | 'local_synthetic_ready'
  | 'provider_preflight_passed'
  | 'real_user_analysis_ready';

export interface EvidencePlan {
  preferred_evidence: EvidenceSource;
  why: string;
  available_sources: Array<{
    source: string;
    kind: ConnectorConfig['kind'];
    provider_backed: boolean;
    auth_ready?: boolean;
    coverage_ready?: boolean;
  }>;
  blocked_sources: Array<{
    source: EvidenceSource | string;
    reason: string;
    next_command?: string;
  }>;
  fallbacks: EvidenceSource[];
  readiness_ceiling: ReadinessTier;
  next_command: string;
}

export interface PreflightPlan {
  experiment_id: string;
  target_route: string;
  app_url: string;
  packet_app_url: string;
  variant_strategy: 'round_robin_for_synthetic_coverage';
  scenario_expected_events: Array<{
    id: string;
    expected_events: string[];
  }>;
  run_required_events: string[];
  guardrail_events: string[];
  evidence: EvidencePlan;
  readiness: {
    current: ReadinessTier;
    ceiling: ReadinessTier;
    blocked: string[];
  };
  next_command: string;
}

export async function resolvePreflightPlan(opts: {
  root: string;
  experiment: Experiment;
  connectors: ConnectorConfig[];
  framework: string;
  appUrl?: string;
}): Promise<PreflightPlan> {
  const targetRoute = chooseTargetRoute(opts.experiment);
  const appUrl = opts.appUrl ?? defaultAppUrlForFramework(opts.framework);
  const packetAppUrl = withStartPath(appUrl, targetRoute);
  const evidence = await resolveEvidencePlan({
    root: opts.root,
    experiment: opts.experiment,
    connectors: opts.connectors,
    packetAppUrl,
  });
  return {
    experiment_id: opts.experiment.id,
    target_route: targetRoute,
    app_url: appUrl,
    packet_app_url: packetAppUrl,
    variant_strategy: 'round_robin_for_synthetic_coverage',
    scenario_expected_events: scenarioExpectedEvents(opts.experiment),
    run_required_events: requiredEvents(opts.experiment),
    guardrail_events: guardrailEvents(opts.experiment),
    evidence,
    readiness: {
      current: evidence.blocked_sources.length ? 'blocked' : 'static_ready',
      ceiling: evidence.readiness_ceiling,
      blocked: evidence.blocked_sources.map((source) => source.reason),
    },
    next_command: evidence.next_command,
  };
}

export async function resolveEvidencePlan(opts: {
  root: string;
  experiment: Experiment;
  connectors: ConnectorConfig[];
  packetAppUrl: string;
}): Promise<EvidencePlan> {
  const provider = opts.connectors.find((connector) => connector.kind === 'posthog');
  const local = opts.connectors.find((connector) => connector.source === 'local' || connector.kind === 'native-app');
  const providerDiscoverable = await detectPostHogConventions(opts.root);
  const availableSources = await Promise.all(
    opts.connectors.map(async (connector) => ({
      source: connector.source,
      kind: connector.kind,
      provider_backed: connector.kind !== 'native-app',
      auth_ready: connector.kind === 'posthog' ? await postHogAuthReady(opts.root, connector) : true,
      coverage_ready: connectorCovers(opts.experiment, connector),
    })),
  );

  if (provider) {
    const authReady = await postHogAuthReady(opts.root, provider);
    const coverageReady = connectorCovers(opts.experiment, provider);
    if (!authReady) {
      return {
        preferred_evidence: 'posthog',
        why: 'A PostHog connector is configured, but provider auth is not ready.',
        available_sources: availableSources,
        blocked_sources: [
          {
            source: provider.source,
            reason: `${provider.source} auth is not configured or required env is missing.`,
            next_command: `growth connector auth check ${provider.source} --json`,
          },
        ],
        fallbacks: local ? ['local_jsonl'] : [],
        readiness_ceiling: local ? 'local_synthetic_ready' : 'blocked',
        next_command: `growth connector auth check ${provider.source} --json`,
      };
    }
    if (!coverageReady) {
      return {
        preferred_evidence: 'posthog',
        why: 'A provider-backed PostHog connector is configured and auth is ready, but mappings do not cover the experiment events.',
        available_sources: availableSources,
        blocked_sources: [
          {
            source: provider.source,
            reason: `${provider.source} mappings do not cover every event required by this experiment.`,
            next_command: `growth connector validate ${provider.source} --json`,
          },
        ],
        fallbacks: local ? ['local_jsonl'] : [],
        readiness_ceiling: local ? 'local_synthetic_ready' : 'blocked',
        next_command: `growth connector validate ${provider.source} --json`,
      };
    }
    return {
      preferred_evidence: 'posthog',
      why: 'Provider-backed PostHog evidence is configured and should validate synthetic preflight ingestion.',
      available_sources: availableSources,
      blocked_sources: [],
      fallbacks: local ? ['local_jsonl'] : [],
      readiness_ceiling: 'provider_preflight_passed',
      next_command: `growth preflight prepare ${opts.experiment.id} --agents 4 --browser --app-url ${opts.packetAppUrl} --json`,
    };
  }

  if (providerDiscoverable) {
    return {
      preferred_evidence: 'posthog',
      why: 'The app appears to use PostHog, but Growth does not have a PostHog connector configured.',
      available_sources: availableSources,
      blocked_sources: [
        {
          source: 'posthog',
          reason: 'PostHog app conventions are discoverable, but no PostHog connector is configured in Growth.',
          next_command: 'growth connector import stripe-projects --json',
        },
      ],
      fallbacks: local ? ['local_jsonl'] : [],
      readiness_ceiling: local ? 'local_synthetic_ready' : 'blocked',
      next_command: 'growth connector import stripe-projects --json',
    };
  }

  if (local) {
    return {
      preferred_evidence: 'local_jsonl',
      why: 'No provider-backed analytics source is configured or discoverable; local JSONL is the available synthetic validation path.',
      available_sources: availableSources,
      blocked_sources: [],
      fallbacks: [],
      readiness_ceiling: 'local_synthetic_ready',
      next_command: `growth preflight prepare ${opts.experiment.id} --agents 4 --browser --app-url ${opts.packetAppUrl} --json`,
    };
  }

  return {
    preferred_evidence: 'local_jsonl',
    why: 'No provider-backed analytics source or local connector is configured.',
    available_sources: availableSources,
    blocked_sources: [
      {
        source: 'local_jsonl',
        reason: 'No evidence connector is configured.',
        next_command: 'growth connector add local --events-file tmp/events.jsonl --json',
      },
    ],
    fallbacks: [],
    readiness_ceiling: 'blocked',
    next_command: 'growth connector add local --events-file tmp/events.jsonl --json',
  };
}

export function chooseTargetRoute(exp: Experiment): string {
  const domain = exp.targeting?.domains?.find((value) => value.startsWith('/'));
  return domain || '/';
}

function withStartPath(appUrl: string, startPath: string): string {
  const url = new URL(appUrl);
  if ((url.pathname === '' || url.pathname === '/') && startPath !== '/') {
    url.pathname = startPath;
  }
  return url.toString().replace(/\/$/, url.pathname === '/' ? '/' : '');
}

function scenarioExpectedEvents(exp: Experiment): PreflightPlan['scenario_expected_events'] {
  return (exp.preflight?.scenarios ?? []).map((scenario) => ({
    id: scenario.id,
    expected_events: scenario.expected_events ?? requiredEvents(exp),
  }));
}

function requiredEvents(exp: Experiment): string[] {
  const out = new Set<string>();
  for (const metric of exp.metrics) {
    out.add(metric.event);
    if (metric.denominator_event) out.add(metric.denominator_event);
  }
  for (const event of exp.instrumentation?.events ?? []) out.add(event.event);
  return Array.from(out).sort();
}

function guardrailEvents(exp: Experiment): string[] {
  return exp.metrics.filter((metric) => metric.role === 'guardrail').map((metric) => metric.event).sort();
}

function connectorCovers(exp: Experiment, connector: ConnectorConfig): boolean {
  try {
    assertCoverage([exp], [connector]);
    return true;
  } catch {
    return false;
  }
}

async function postHogAuthReady(root: string, connector: ConnectorConfig): Promise<boolean> {
  if (connector.kind !== 'posthog') return true;
  const apiKeyEnv = connectorApiKeyEnv(connector);
  const projectId = connector.posthog?.project_id;
  const apiKeyPresent = apiKeyEnv ? !!(await readEnvValue(root, apiKeyEnv)) : true;
  const projectIdPresent =
    projectId === undefined ||
    typeof projectId === 'number' ||
    (typeof projectId === 'string' && (!isEnvReference(projectId) || !!(await readEnvValue(root, projectId))));
  return apiKeyPresent && projectIdPresent;
}

async function detectPostHogConventions(root: string): Promise<boolean> {
  const env = await readLocalEnv(root);
  if (Object.keys(env).some((key) => key.includes('POSTHOG'))) return true;
  if (await fileContains(root, 'package.json', 'posthog')) return true;
  if (await fileContains(root, 'instrumentation-client.ts', 'posthog')) return true;
  if (await fileContains(root, 'instrumentation-client.js', 'posthog')) return true;
  if (await fileContains(root, '.posthog-events.json', 'event')) return true;
  for (const file of projectFiles) {
    if (await fileContains(root, file, 'posthog')) return true;
  }
  return false;
}

const projectFiles = [
  path.join('.projects', 'state.json'),
  path.join('.projects', 'state.local.json'),
  path.join('.projects', 'providers.json'),
  path.join('.stripe-projects', 'state.json'),
];

async function fileContains(root: string, rel: string, needle: string): Promise<boolean> {
  try {
    return (await fs.readFile(path.join(root, rel), 'utf8')).toLowerCase().includes(needle.toLowerCase());
  } catch {
    return false;
  }
}

function isEnvReference(value: string): boolean {
  return /^[A-Z_][A-Z0-9_]*$/.test(value);
}
