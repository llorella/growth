import type { ConnectorConfig } from '../../connectors/types.js';
import type { ProjectProfile } from '../../lib/project-profile.js';
import type { Experiment } from '../experiment/types.js';
import {
  SYNTHETIC_TRAFFIC_FIELDS,
  SYNTHETIC_TRAFFIC_QUERY_PARAMS,
  SYNTHETIC_TRAFFIC_REQUIRED_PROPERTIES,
} from '../evidence/synthetic-traffic.js';
import type { ReadinessTier } from '../preflight/plan.js';

const REQUIRED_EVENT_PROPERTIES = [
  'experiment_id',
  'variant_id',
  'user_id',
  'session_id',
  'timestamp',
  ...SYNTHETIC_TRAFFIC_REQUIRED_PROPERTIES,
];

export interface RequiredEventSpec {
  event: string;
  required_properties: string[];
}

export type AssignmentIdentityGuidance =
  | {
      stable_by: string;
      recommended_stable_by: string;
      status: 'ok';
      reason: string;
      evidence: string[];
    }
  | {
      stable_by: string;
      recommended_stable_by: string;
      status: 'review';
      reason: string;
      evidence: string[];
      warning: { code: string; message: string };
    };

export interface InstrumentationPitfall {
  id: string;
  applies_to: string;
  message: string;
  fix: string;
  evidence?: unknown;
}

export function preflightReadinessBasis(
  readyForPreflight: boolean,
  readiness: ReturnType<typeof readinessModel>,
): 'blocked' | 'static_contract' | 'emitted_synthetic_events' {
  if (!readyForPreflight) return 'blocked';
  return readiness.local_synthetic_ready ? 'emitted_synthetic_events' : 'static_contract';
}

export function readinessModel(opts: {
  connectorCoverageOk: boolean;
  endpointOk?: boolean;
  actualEventOk?: boolean;
  actualEventProvided: boolean;
}): {
  tier: ReadinessTier;
  static_ready: boolean;
  local_synthetic_ready: boolean;
  provider_preflight_passed: boolean;
  notes: string[];
} {
  const notes: string[] = [];
  if (!opts.connectorCoverageOk) {
    notes.push('Connector coverage is unresolved; run growth preflight plan for provider/local evidence setup.');
  }
  if (opts.actualEventProvided && !opts.actualEventOk) {
    notes.push('Actual emitted event evidence is incomplete.');
  }
  if (opts.endpointOk === false) {
    notes.push('Endpoint sample verification failed.');
  }
  const staticReady = opts.connectorCoverageOk && opts.endpointOk !== false;
  const localSyntheticReady = staticReady && opts.actualEventOk === true;
  return {
    tier: localSyntheticReady ? 'local_synthetic_ready' : staticReady ? 'static_ready' : 'blocked',
    static_ready: staticReady,
    local_synthetic_ready: localSyntheticReady,
    provider_preflight_passed: false,
    notes,
  };
}

export function buildContract(exp: Experiment) {
  return {
    assignment: exp.instrumentation?.assignment ?? {
      stable_by: 'user_id',
      properties: ['experiment_id', 'variant_id', 'user_id'],
    },
    events: requiredEventSpecs(exp),
    agent_traffic: {
      required_properties: SYNTHETIC_TRAFFIC_REQUIRED_PROPERTIES,
      query_params: SYNTHETIC_TRAFFIC_QUERY_PARAMS,
      synthetic_context: syntheticContextContract(exp),
    },
  };
}

function syntheticContextContract(exp: Experiment) {
  return {
    storage: {
      adapter: 'sessionStorage',
      key: `growth.synthetic_context.${exp.id}`,
    },
    capture: {
      source: 'url_query_params',
      when: 'earliest_app_entrypoint_before_auth_redirects_or_client_navigation',
      query_params: SYNTHETIC_TRAFFIC_QUERY_PARAMS.map((param) => param.name),
    },
    event_properties: [
      {
        query_param: SYNTHETIC_TRAFFIC_FIELDS.agentGenerated,
        property: SYNTHETIC_TRAFFIC_FIELDS.agentGenerated,
        type: 'boolean',
        required_for_synthetic: true,
      },
      {
        query_param: SYNTHETIC_TRAFFIC_FIELDS.agentRunId,
        property: SYNTHETIC_TRAFFIC_FIELDS.agentRunId,
        type: 'string',
        required_for_synthetic: true,
      },
      {
        query_param: SYNTHETIC_TRAFFIC_FIELDS.experimentId,
        property: SYNTHETIC_TRAFFIC_FIELDS.experimentId,
        type: 'string',
        required_for_synthetic: true,
      },
      {
        query_param: SYNTHETIC_TRAFFIC_FIELDS.forcedVariant,
        property: SYNTHETIC_TRAFFIC_FIELDS.variantId,
        type: 'string',
        required_for_synthetic: true,
        meaning: 'Forced synthetic packet branch. Use it as assignment override and emit variant_id.',
      },
    ],
    reset_rule:
      'Only replace stored synthetic context when agent_run_id changes or no stored context exists.',
    propagation_rule:
      'Attach stored synthetic context to every experiment event before connector-specific shaping.',
  };
}

export function assignmentIdentityGuidance(exp: Experiment, projectProfile?: ProjectProfile): AssignmentIdentityGuidance {
  const stableBy = exp.instrumentation?.assignment?.stable_by ?? 'user_id';
  const evidence = authenticatedTargetingEvidence(projectProfile);
  const authenticatedSurface = evidence.length > 0;
  const userStableKey = isUserStableKey(stableBy);
  if (authenticatedSurface && !userStableKey) {
    const reason =
      'Targeting indicates an authenticated surface, so assignment should normally be stable by user_id to avoid cross-device or cross-browser variant drift.';
    return {
      stable_by: stableBy,
      recommended_stable_by: 'user_id',
      status: 'review',
      reason,
      evidence,
      warning: {
        code: 'AUTHENTICATED_ASSIGNMENT_STABLE_BY',
        message: `${reason} Current stable_by is "${stableBy}".`,
      },
    };
  }
  return {
    stable_by: stableBy,
    recommended_stable_by: authenticatedSurface ? 'user_id' : stableBy,
    status: 'ok',
    reason: authenticatedSurface
      ? 'Targeting indicates an authenticated surface and assignment is stable by user identity.'
      : 'No authenticated targeting signal was detected.',
    evidence,
  };
}

function authenticatedTargetingEvidence(projectProfile?: ProjectProfile): string[] {
  return (projectProfile?.auth_contexts ?? [])
    .filter((authContext) => authContext.requires_session)
    .map((authContext) => `project_profile.auth_contexts:${authContext.id}`);
}

function isUserStableKey(stableBy: string): boolean {
  return /^(user_id|user\.id|session\.user\.id)$/.test(stableBy);
}

export function variantIntegrityGuidance(exp: Experiment) {
  const control = exp.variants[0];
  return {
    control_variant_id: control?.id ?? null,
    treatment_variant_ids: exp.variants.slice(1).map((variant) => variant.id),
    requirements: [
      'Treat the first variant as the baseline control.',
      'Preserve control behavior, layout, and copy except for shared instrumentation required to measure the experiment.',
      'Keep treatment-only product changes behind assignment logic or concrete variant implementation metadata.',
      'Emit the canonical assigned variant_id on every event so analysis can distinguish control from treatment.',
    ],
  };
}

export function connectorEventShape(connector: ConnectorConfig) {
  const sample: Record<string, unknown> = {};
  if (connector.event_name_path === 'event') sample.event = 'experiment_viewed';
  if (connector.timestamp_path === 'timestamp') sample.timestamp = new Date().toISOString();
  const properties: Record<string, unknown> = {};
  const addPathSample = (dotPath: string | undefined, value: unknown) => {
    if (!dotPath) return;
    if (!dotPath.startsWith('properties.')) return;
    properties[dotPath.replace(/^properties\./, '')] = value;
  };
  addPathSample(connector.user_id_path, 'user_123');
  addPathSample(connector.anonymous_id_path, 'anon_123');
  addPathSample(connector.experiment_id_path, 'experiment-id');
  addPathSample(connector.variant_id_path, 'control');
  addPathSample(connector.timestamp_path, new Date().toISOString());
  addPathSample(connector.idempotency_key_path, 'evt_unique_id');
  if (Object.keys(properties).length) sample.properties = properties;
  return {
    source: connector.source,
    kind: connector.kind,
    event_name_path: connector.event_name_path,
    user_id_path: connector.user_id_path,
    anonymous_id_path: connector.anonymous_id_path,
    experiment_id_path: connector.experiment_id_path,
    variant_id_path: connector.variant_id_path,
    timestamp_path: connector.timestamp_path,
    idempotency_key_path: connector.idempotency_key_path,
    example_event: sample,
  };
}

export function referenceImplementation(framework: string) {
  const sharedNotes = [
    'Use `variant_id` as the canonical emitted event property. The URL query param is still named `variant` because it forces assignment for a synthetic packet.',
    'If a connector requires a legacy `variant` property, emit it as an alias with the same value as `variant_id`.',
  ];
  if (framework === 'nextjs-app-router') {
    return {
      advisory_only: true,
      skill_reference: '.agents/skills/growth/references/nextjs-app-router.md',
      notes: [
        'Read URL params agent_generated, agent_run_id, experiment_id, and variant before hashing assignment.',
        'Prefer one app-level synthetic context helper that captures, persists, and returns the synthetic context for event emitters.',
        'Persist synthetic query params to sessionStorage before Link/router navigation removes them.',
        'Only reset synthetic per-event dedupe when agent_run_id changes.',
        'Emit event envelopes that match connector_event_shapes for the source selected by Growth.',
        ...sharedNotes,
      ],
    };
  }
  if (framework === 'react-vite') {
    return {
      advisory_only: true,
      skill_reference: '.agents/skills/growth/references/spa-navigation.md',
      notes: [
        'React Router Link/NavLink/useNavigate calls do not preserve URL query params by default.',
        'Prefer one app-level synthetic context helper that captures, persists, and returns the synthetic context for event emitters.',
        'Persist synthetic query params to sessionStorage on first page load and read from there on every event.',
        'Emit event envelopes that match connector_event_shapes for the source selected by Growth.',
        ...sharedNotes,
      ],
    };
  }
  return {
    advisory_only: true,
    notes: [
      'Prefer one app-level synthetic context helper that captures, persists, and returns the synthetic context for event emitters.',
      'Persist assignment by stable id.',
      'Attach preflight query params to every synthetic event.',
      'Emit event payloads that match connector_event_shapes.',
      ...sharedNotes,
    ],
  };
}

export function knownPitfalls(exp: Experiment, connector?: ConnectorConfig, projectProfile?: ProjectProfile): InstrumentationPitfall[] {
  const pitfalls: InstrumentationPitfall[] = [
    {
      id: 'variant-field-duality',
      applies_to: 'all',
      message:
        '`variant_id` is the canonical event property. The preflight URL query param is named `variant` only to force synthetic assignment.',
      fix: 'Emit properties.variant_id on every event; optionally emit properties.variant as an alias only for legacy connector compatibility.',
    },
    {
      id: 'synthetic-context-persistence',
      applies_to: 'all',
      message:
        'Synthetic browser packets rely on URL query params that may be lost during redirects or client navigation.',
      fix: 'Capture preflight query params once, persist them through the synthetic context contract, and attach the persisted values to every experiment event.',
    },
  ];
  if (connector?.kind === 'posthog') {
    pitfalls.push({
      id: 'posthog-bot-detection',
      applies_to: 'synthetic-browser-preflight',
      message:
        'PostHog\'s default bot detection silently drops events from HeadlessChrome and other automated user agents. Synthetic preflight traffic will emit zero events unless the filter is disabled in dev.',
      fix: 'Set `opt_out_useragent_filter: true` in your PostHog client init options for development/test environments.',
    });
  }
  const authenticatedEvidence = authenticatedTargetingEvidence(projectProfile);
  if (authenticatedEvidence.length) {
    pitfalls.unshift({
      id: 'auth-gated-synthetic-context',
      applies_to: 'authenticated-targeting-detected',
      message:
        'Authenticated routes may redirect before the instrumented page or component reads ?agent_generated, ?agent_run_id, ?experiment_id, and ?variant.',
      fix: 'Capture and persist synthetic query params at the earliest app entry point before auth redirects, route guards, or server/client navigation can strip them.',
      evidence: authenticatedEvidence,
    });
  }
  return pitfalls;
}

export function requiredEvents(exp: Experiment): string[] {
  return requiredEventSpecs(exp).map((spec) => spec.event);
}

export function requiredEventSpecs(exp: Experiment): RequiredEventSpec[] {
  const out = new Map<string, Set<string>>();
  const add = (event: string | undefined, requiredProperties: string[]) => {
    if (!event) return;
    const props = out.get(event) ?? new Set<string>();
    for (const prop of requiredProperties) props.add(prop);
    out.set(event, props);
  };
  for (const metric of exp.metrics) {
    add(metric.event, REQUIRED_EVENT_PROPERTIES);
    add(metric.denominator_event, REQUIRED_EVENT_PROPERTIES);
  }
  for (const event of exp.instrumentation?.events ?? []) {
    add(event.event, event.required_properties);
  }
  return Array.from(out.entries())
    .map(([event, props]) => ({
      event,
      required_properties: Array.from(props).sort(),
    }))
    .sort((a, b) => a.event.localeCompare(b.event));
}

export function sampleEvents(exp: Experiment) {
  return requiredEventSpecs(exp).map((spec) => ({
    event: spec.event,
    distinct_id: 'user_sample_123',
    properties: sampleProperties(exp, spec),
  }));
}

function sampleProperties(exp: Experiment, spec: RequiredEventSpec): Record<string, unknown> {
  const variantId = exp.variants[0]?.id ?? 'control';
  const known: Record<string, unknown> = {
    event_id: `evt_${spec.event}_sample`,
    experiment_id: exp.id,
    variant: variantId,
    variant_id: variantId,
    user_id: 'user_sample_123',
    anonymous_id: 'anon_sample_123',
    session_id: 'session_sample_123',
    timestamp: new Date().toISOString(),
    [SYNTHETIC_TRAFFIC_FIELDS.agentGenerated]: false,
    [SYNTHETIC_TRAFFIC_FIELDS.agentRunId]: null,
    assignment_id: `assign_${exp.id}_sample`,
    value: 1,
  };
  const out: Record<string, unknown> = {};
  out.event_id = known.event_id;
  for (const prop of spec.required_properties) {
    out[prop] = prop in known ? known[prop] : `sample_${prop}`;
  }
  return out;
}
