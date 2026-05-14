import type { Experiment } from '../experiment/types.js';
import { connectorAdapterFor } from '../../connectors/registry.js';
import type { ConnectorAdapter, ConnectorCapabilityStatus } from '../../connectors/types.js';
import { defaultAppUrlForFramework } from '../../lib/app-url.js';
import type { ConnectorConfig } from '../../lib/connectors.js';
import type { ProjectProfile } from '../../lib/project-profile.js';
import {
  preflightCoverage,
  scenarioExpectedEvents as coverageScenarioExpectedEvents,
} from './coverage.js';

export type EvidenceSource = 'posthog' | 'local_jsonl' | 'unconfigured';
export type ReadinessTier =
  | 'blocked'
  | 'static_ready'
  | 'local_synthetic_ready'
  | 'provider_preflight_passed';

export interface EvidencePlan {
  preferred_evidence: EvidenceSource;
  why: string;
  available_sources: Array<{
    source: string;
    kind: ConnectorConfig['kind'];
    evidence_source: EvidenceSource;
    provider_backed: boolean;
    telemetry_write_ready?: boolean;
    provider_pull_ready?: boolean;
    capabilities?: ConnectorCapabilityStatus['capabilities'];
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
  target_route_source: {
    kind: 'experiment_targeting' | 'project_profile' | 'default_root';
    value?: string;
    route_id?: string;
  };
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
  projectProfile?: ProjectProfile;
  appUrl?: string;
}): Promise<PreflightPlan> {
  const targetRoute = chooseTargetRoute(opts.experiment, opts.projectProfile);
  const appUrl = opts.appUrl ?? defaultAppUrlForFramework(opts.framework);
  const packetAppUrl = withStartPath(appUrl, targetRoute.path);
  const evidence = await resolveEvidencePlan({
    root: opts.root,
    experiment: opts.experiment,
    connectors: opts.connectors,
    packetAppUrl,
  });
  return {
    experiment_id: opts.experiment.id,
    target_route: targetRoute.path,
    target_route_source: targetRoute.source,
    app_url: appUrl,
    packet_app_url: packetAppUrl,
    browser_context: browserContextPlan(opts.experiment, opts.projectProfile),
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
  const connectorPlans = await Promise.all(
    opts.connectors.map(async (connector) => {
      const adapter = connectorAdapterFor(connector);
      if (!adapter) return undefined;
      const capabilities = await adapter.capabilityStatus(opts.root, connector);
      return {
        connector,
        adapter,
        capabilities,
        coverageReady: adapter.coverage(connector, opts.experiment),
      };
    }),
  ).then((plans) => plans.filter((plan): plan is ConnectorPlan => !!plan));
  const provider = connectorPlans.find((plan) => plan.adapter.providerBacked);
  const local = connectorPlans.find((plan) => plan.adapter.evidenceSource === 'local_jsonl');
  const availableSources = connectorPlans.map((plan) => availableSource(plan));

  if (provider) {
    const providerPull = provider.capabilities.capabilities.provider_pull ?? {
      ready: false,
      missing: ['provider_pull'],
    };
    if (!providerPull.ready) {
      return {
        preferred_evidence: provider.adapter.evidenceSource,
        why: provider.adapter.providerPullBlockedWhy(provider.capabilities),
        available_sources: availableSources,
        blocked_sources: [
          {
            source: provider.connector.source,
            capability: 'provider_pull',
            reason: provider.adapter.providerPullBlockReason(provider.connector, provider.capabilities),
            missing: providerPull.missing,
            next_command: `growth connector auth setup ${provider.connector.source} --json`,
            manual_input_required: true,
          },
        ],
        fallbacks: local ? ['local_jsonl'] : [],
        readiness_ceiling: local ? 'local_synthetic_ready' : 'blocked',
        next_command: `growth connector auth setup ${provider.connector.source} --json`,
      };
    }
    if (!provider.coverageReady) {
      return {
        preferred_evidence: provider.adapter.evidenceSource,
        why: provider.adapter.coverageBlockedWhy(provider.connector),
        available_sources: availableSources,
        blocked_sources: [
          {
            source: provider.connector.source,
            capability: 'connector_coverage',
            reason: `${provider.connector.source} mappings do not cover every event required by this experiment.`,
            next_command: `growth connector validate ${provider.connector.source} --json`,
          },
        ],
        fallbacks: local ? ['local_jsonl'] : [],
        readiness_ceiling: local ? 'local_synthetic_ready' : 'blocked',
        next_command: `growth connector validate ${provider.connector.source} --json`,
      };
    }
    return {
      preferred_evidence: provider.adapter.evidenceSource,
      why: provider.adapter.readyWhy(),
      available_sources: availableSources,
      blocked_sources: [],
      fallbacks: local ? ['local_jsonl'] : [],
      readiness_ceiling: 'provider_preflight_passed',
      next_command: `growth preflight run ${opts.experiment.id} --agents 4 --browser --app-url ${opts.packetAppUrl} --json`,
    };
  }

  if (local) {
    return {
      preferred_evidence: 'local_jsonl',
      why: local.adapter.readyWhy(),
      available_sources: availableSources,
      blocked_sources: [],
      fallbacks: [],
      readiness_ceiling: 'local_synthetic_ready',
      next_command: `growth preflight run ${opts.experiment.id} --agents 4 --browser --app-url ${opts.packetAppUrl} --json`,
    };
  }

  return {
    preferred_evidence: 'unconfigured',
    why: 'No evidence connector is configured. Growth will not infer a provider from source text or environment names during preflight planning.',
    available_sources: availableSources,
    blocked_sources: [
      {
        source: 'evidence_connector',
        reason: 'No evidence connector is configured in Growth.',
        next_command: 'growth connector import stripe-projects --json',
      },
    ],
    fallbacks: [],
    readiness_ceiling: 'blocked',
    next_command: 'growth connector import stripe-projects --json',
  };
}

interface ConnectorPlan {
  connector: ConnectorConfig;
  adapter: ConnectorAdapter;
  capabilities: ConnectorCapabilityStatus;
  coverageReady: boolean;
}

function availableSource(plan: ConnectorPlan): EvidencePlan['available_sources'][number] {
  const telemetryWrite = plan.capabilities.capabilities.telemetry_write;
  const providerPull = plan.capabilities.capabilities.provider_pull;
  return {
    source: plan.connector.source,
    kind: plan.connector.kind,
    evidence_source: plan.adapter.evidenceSource,
    provider_backed: plan.adapter.providerBacked,
    ...(telemetryWrite ? { telemetry_write_ready: telemetryWrite.ready } : {}),
    ...(providerPull ? { provider_pull_ready: providerPull.ready } : {}),
    ...(Object.keys(plan.capabilities.capabilities).length ? { capabilities: plan.capabilities.capabilities } : {}),
    coverage_ready: plan.coverageReady,
  };
}

export function chooseTargetRoute(
  exp: Experiment,
  projectProfile?: ProjectProfile,
): {
  path: string;
  source: PreflightPlan['target_route_source'];
} {
  for (const domain of exp.targeting?.domains ?? []) {
    const explicitPath = explicitPathFromTargetingDomain(domain);
    if (explicitPath) {
      return {
        path: explicitPath,
        source: { kind: 'experiment_targeting', value: domain },
      };
    }
    const matchingRoute = projectProfile?.routes.find((route) => route.id === domain);
    if (matchingRoute) {
      return {
        path: matchingRoute.path,
        source: { kind: 'project_profile', route_id: matchingRoute.id },
      };
    }
  }
  if (projectProfile?.routes.length === 1) {
    const [route] = projectProfile.routes;
    return {
      path: route.path,
      source: { kind: 'project_profile', route_id: route.id },
    };
  }
  return {
    path: '/',
    source: { kind: 'default_root' },
  };
}

function browserContextPlan(exp: Experiment, projectProfile?: ProjectProfile): PreflightPlan['browser_context'] {
  const evidence = authenticatedTargetingEvidence(projectProfile);
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

function authenticatedTargetingEvidence(projectProfile?: ProjectProfile): string[] {
  return (projectProfile?.auth_contexts ?? [])
    .filter((authContext) => authContext.requires_session)
    .map((authContext) => `project_profile.auth_contexts:${authContext.id}`);
}

export function withStartPath(appUrl: string, startPath: string): string {
  const url = new URL(appUrl);
  if ((url.pathname === '' || url.pathname === '/') && startPath !== '/') {
    url.pathname = startPath;
  }
  return url.toString().replace(/\/$/, url.pathname === '/' ? '/' : '');
}

function explicitPathFromTargetingDomain(domain: string): string | null {
  const trimmed = domain.trim();
  if (trimmed.startsWith('/')) return trimmed;
  try {
    const url = new URL(trimmed);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    return url.pathname && url.pathname !== '/' ? url.pathname : null;
  } catch {
    // Non-URL domains can still refer to a project profile route id.
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
