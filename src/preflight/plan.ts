import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { Experiment } from '../domain/types.js';
import { readLocalEnv } from '../lib/env-files.js';
import { defaultAppUrlForFramework } from '../lib/app-url.js';
import { assertCoverage, type ConnectorConfig } from '../lib/connectors.js';
import { postHogCapabilityStatus, type PostHogCapabilityStatus } from '../lib/posthog-capabilities.js';
import {
  preflightCoverage,
  scenarioExpectedEvents as coverageScenarioExpectedEvents,
} from './coverage.js';

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
    telemetry_write_ready?: boolean;
    provider_pull_ready?: boolean;
    capabilities?: PostHogCapabilityStatus['capabilities'];
    coverage_ready?: boolean;
  }>;
  blocked_sources: Array<{
    source: EvidenceSource | string;
    capability?: 'provider_pull' | 'connector_coverage';
    reason: string;
    missing?: string[];
    next_command?: string;
    manual_input_required?: boolean;
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
  browser_context: {
    requires_authenticated_session: boolean;
    evidence: string[];
    requirements: string[];
    blocker_report_fields: string[];
  };
  variant_strategy: 'round_robin_for_synthetic_coverage';
  scenario_expected_events: Array<{
    id: string;
    expected_events: string[];
  }>;
  run_required_events: string[];
  guardrail_events: string[];
  variant_implementations: Array<{
    variant_id: string;
    status?: string;
    branch?: string;
    worktree_path?: string;
    commit?: string;
    pr_url?: string;
    app_url?: string;
  }>;
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
    browser_context: browserContextPlan(opts.experiment),
    variant_strategy: 'round_robin_for_synthetic_coverage',
    scenario_expected_events: scenarioExpectedEvents(opts.experiment),
    run_required_events: requiredEvents(opts.experiment),
    guardrail_events: guardrailEvents(opts.experiment),
    variant_implementations: variantImplementations(opts.experiment),
    evidence,
    readiness: {
      current: evidence.blocked_sources.length ? 'blocked' : 'static_ready',
      ceiling: evidence.readiness_ceiling,
      blocked: evidence.blocked_sources.map((source) => source.reason),
    },
    next_command: evidence.next_command,
  };
}

function variantImplementations(exp: Experiment): PreflightPlan['variant_implementations'] {
  return exp.variants.map((variant) => ({
    variant_id: variant.id,
    ...(variant.implementation ?? {}),
  }));
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
    opts.connectors.map(async (connector) => {
      const capabilities = connector.kind === 'posthog' ? await postHogCapabilityStatus(opts.root, connector) : undefined;
      return {
        source: connector.source,
        kind: connector.kind,
        provider_backed: connector.kind !== 'native-app',
        ...(capabilities
          ? {
              telemetry_write_ready: capabilities.capabilities.telemetry_write.ready,
              provider_pull_ready: capabilities.capabilities.provider_pull.ready,
              capabilities: capabilities.capabilities,
            }
          : {}),
        coverage_ready: connectorCovers(opts.experiment, connector),
      };
    }),
  );

  if (provider) {
    const capabilities = await postHogCapabilityStatus(opts.root, provider);
    const providerPull = capabilities.capabilities.provider_pull;
    const coverageReady = connectorCovers(opts.experiment, provider);
    if (!providerPull.ready) {
      return {
        preferred_evidence: 'posthog',
        why: capabilities.capabilities.telemetry_write.ready
          ? 'PostHog app telemetry is configured, but provider-backed evidence pull is not ready.'
          : 'A PostHog connector is configured, but telemetry and provider-backed evidence are not ready.',
        available_sources: availableSources,
        blocked_sources: [
          {
            source: provider.source,
            capability: 'provider_pull',
            reason: providerPullBlockReason(provider.source, capabilities),
            missing: providerPull.missing,
            next_command: `growth connector auth setup ${provider.source} --json`,
            manual_input_required: true,
          },
        ],
        fallbacks: local ? ['local_jsonl'] : [],
        readiness_ceiling: local ? 'local_synthetic_ready' : 'blocked',
        next_command: `growth connector auth setup ${provider.source} --json`,
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
            capability: 'connector_coverage',
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
      next_command: `growth preflight run ${opts.experiment.id} --agents 4 --browser --app-url ${opts.packetAppUrl} --json`,
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
      next_command: `growth preflight run ${opts.experiment.id} --agents 4 --browser --app-url ${opts.packetAppUrl} --json`,
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
  if (domain) return domain;
  return routeFromScenarios(exp) ?? '/';
}

function browserContextPlan(exp: Experiment): PreflightPlan['browser_context'] {
  const evidence = authenticatedTargetingEvidence(exp);
  const requiresAuthenticatedSession = evidence.length > 0;
  return {
    requires_authenticated_session: requiresAuthenticatedSession,
    evidence,
    requirements: requiresAuthenticatedSession
      ? [
          'Run browser packets with an authenticated test session that can access the target route.',
          'Preserve synthetic query params through login, auth redirects, and route guards.',
          'If the packet stops at login or a paywall, report the blocker instead of treating the instrumentation contract as verified.',
        ]
      : [],
    blocker_report_fields: ['auth_or_payment_blockers', 'blockers'],
  };
}

function authenticatedTargetingEvidence(exp: Experiment): string[] {
  const evidence: string[] = [];
  const authPattern = /\b(authenticated|logged[- ]?in|signed[- ]?in|session user|session\.user|user_id|user\.id)\b/i;
  for (const segment of exp.targeting?.segments ?? []) {
    if (authPattern.test(segment)) evidence.push(`targeting.segments:${segment}`);
  }
  for (const rule of exp.targeting?.rules ?? []) {
    const text = `${rule.field} ${String(rule.value)}`;
    if (authPattern.test(text)) evidence.push(`targeting.rules:${text}`);
  }
  return evidence;
}

export function withStartPath(appUrl: string, startPath: string): string {
  const url = new URL(appUrl);
  if ((url.pathname === '' || url.pathname === '/') && startPath !== '/') {
    url.pathname = startPath;
  }
  return url.toString().replace(/\/$/, url.pathname === '/' ? '/' : '');
}

function routeFromScenarios(exp: Experiment): string | null {
  for (const scenario of exp.preflight?.scenarios ?? []) {
    const text = [scenario.goal, ...(scenario.instructions ?? [])].join('\n');
    const route = firstRouteMention(text);
    if (route) return route;
  }
  return null;
}

function firstRouteMention(text: string): string | null {
  const matches = text.matchAll(/(^|[\s([{"'`])(?<route>\/[a-zA-Z0-9][a-zA-Z0-9/_-]*)(?=$|[\s).,!?:;"'`}])/g);
  for (const match of matches) {
    const route = match.groups?.route;
    if (route && !route.includes('//')) return route;
  }
  return null;
}

function scenarioExpectedEvents(exp: Experiment): PreflightPlan['scenario_expected_events'] {
  return preflightCoverage(exp).scenarios.map((scenario) => ({
    id: scenario.id,
    expected_events: coverageScenarioExpectedEvents(exp, scenario),
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

function providerPullBlockReason(source: string, status: PostHogCapabilityStatus): string {
  if (status.capabilities.telemetry_write.ready && status.capabilities.provider_pull.missing.length === 1) {
    return `${source} app telemetry is configured, but provider-backed preflight needs a PostHog project id to pull synthetic events.`;
  }
  return `${source} provider-backed preflight is blocked because required read-side values are missing: ${status.capabilities.provider_pull.missing.join(', ')}.`;
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
