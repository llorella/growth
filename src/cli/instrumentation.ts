import type { Command } from 'commander';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { wrap, type RunCtx } from '../lib/runner.js';
import { requireInitialized } from '../lib/gating.js';
import { Store } from '../lib/store.js';
import { GrowthError } from '../lib/envelope.js';
import { detectFramework, suggestedInstrumentationFiles } from '../lib/framework.js';
import { resolveAppUrl } from '../lib/app-url.js';
import { listConnectors, assertCoverage, type ConnectorConfig } from '../lib/connectors.js';
import { paths } from '../lib/paths.js';
import type { Experiment } from '../domain/types.js';
import { resolvePreflightPlan, type ReadinessTier } from '../preflight/plan.js';
import {
  SYNTHETIC_TRAFFIC_FIELDS,
  SYNTHETIC_TRAFFIC_QUERY_PARAMS,
  SYNTHETIC_TRAFFIC_REQUIRED_PROPERTIES,
} from '../domain/synthetic-traffic.js';
import { scanSpaAgentContext, type SpaAgentContextScan } from '../lib/code-hints.js';

const REQUIRED_EVENT_PROPERTIES = [
  'experiment_id',
  'variant_id',
  'user_id',
  'session_id',
  'timestamp',
  ...SYNTHETIC_TRAFFIC_REQUIRED_PROPERTIES,
];

interface RequiredEventSpec {
  event: string;
  required_properties: string[];
}

export function registerInstrumentation(program: Command, ctx: RunCtx): void {
  const instrumentation = program
    .command('instrumentation')
    .description('Plan and verify application instrumentation for experiments.');

  instrumentation
    .command('plan <experiment_id>')
    .description('Generate the instrumentation contract for an experiment.')
    .action(async (experimentId: string) => {
      await wrap('growth instrumentation plan', ctx, async () => {
        await requireInitialized(ctx.getRoot());
        const store = new Store(ctx.getRoot());
        const exp = await store.getExperiment(experimentId);
        if (!exp) throw new GrowthError('not_found', `Experiment "${experimentId}" not found.`);
        const framework = await detectFramework(ctx.getRoot());
        const contract = buildContract(exp);
        const suggestedFiles = await suggestedInstrumentationFiles(ctx.getRoot(), framework);
        const connectors = await listConnectors(ctx.getRoot());
        const appUrl = await resolveAppUrl(ctx.getRoot(), framework);
        const spaAgentContext = await scanSpaAgentContext(ctx.getRoot());
        const assignmentIdentity = assignmentIdentityGuidance(exp);
        const variantIntegrity = variantIntegrityGuidance(exp);
        return {
          data: {
            framework,
            framework_hint: { detected: framework, advisory_only: true },
            app_url: appUrl,
            experiment_id: exp.id,
            required_contract: contract,
            assignment_identity: assignmentIdentity,
            variant_integrity: variantIntegrity,
            candidate_files: suggestedFiles,
            suggested_files: suggestedFiles,
            connector_event_shapes: connectors.map(connectorEventShape),
            preflight_query_params: SYNTHETIC_TRAFFIC_QUERY_PARAMS,
            known_pitfalls: knownPitfalls(spaAgentContext, exp),
            reference_implementation: referenceImplementation(framework),
            prompt_packet: {
              summary: `Instrument ${exp.id} so assignments are stable and all required events include the growth properties.`,
              rules: [
                'Inspect the repository and follow existing app conventions before choosing files to edit.',
                'Read preflight query params before implementing assignment.',
                'If the app uses client-side navigation, persist synthetic query params to sessionStorage before navigation strips the query string.',
                ...(assignmentIdentity.evidence.length
                  ? ['On authenticated routes, capture synthetic query params before auth redirects or route guards can strip them.']
                  : []),
                'Preserve the control variant behavior and copy except for instrumentation needed to measure the experiment.',
                'Emit events in the shape expected by the active connector paths.',
                'Persist assignment and per-event idempotency keys so rerenders do not duplicate events.',
                ...(assignmentIdentity.status === 'review'
                  ? ['Use user_id for stable assignment on authenticated surfaces unless the experiment has an explicit cross-device reason not to.']
                  : []),
              ],
              commands_after_editing: [
                `growth instrumentation verify ${exp.id} --json`,
                `growth instrumentation verify ${exp.id} --events-file <events.jsonl> --json`,
              ],
            },
          },
          humanText: JSON.stringify(contract, null, 2),
          nextSteps: [
            'Edit the app to satisfy the event contract.',
            'Treat candidate_files and framework_hint as advisory; inspect the codebase before editing.',
            'Use connector_event_shapes from the JSON output when shaping app events.',
            `Run growth instrumentation verify ${exp.id} --json.`,
            `Use growth preflight run ${exp.id} --agents 4 --browser --app-url ${appUrl} --json when ready.`,
          ],
          next: {
            command: `growth instrumentation verify ${exp.id} --json`,
            until: 'app instrumentation has been edited and the static contract verifies',
          },
          warnings: assignmentIdentity.status === 'review' ? [assignmentIdentity.warning] : [],
        };
      });
    });

  instrumentation
    .command('events <experiment_id>')
    .description('List required events for an experiment.')
    .action(async (experimentId: string) => {
      await wrap('growth instrumentation events', ctx, async () => {
        await requireInitialized(ctx.getRoot());
        const store = new Store(ctx.getRoot());
        const exp = await store.getExperiment(experimentId);
        if (!exp) throw new GrowthError('not_found', `Experiment "${experimentId}" not found.`);
        return {
          data: { events: requiredEvents(exp) },
          humanText: requiredEvents(exp).map((e) => `  ${e}`).join('\n'),
        };
      });
    });

  instrumentation
    .command('sample <experiment_id>')
    .description('Generate sample event payloads for an experiment.')
    .action(async (experimentId: string) => {
      await wrap('growth instrumentation sample', ctx, async () => {
        await requireInitialized(ctx.getRoot());
        const store = new Store(ctx.getRoot());
        const exp = await store.getExperiment(experimentId);
        if (!exp) throw new GrowthError('not_found', `Experiment "${experimentId}" not found.`);
        const samples = sampleEvents(exp);
        return {
          data: { samples },
          humanText: JSON.stringify(samples, null, 2),
        };
      });
    });

  instrumentation
    .command('verify <experiment_id>')
    .description('Verify experiment instrumentation contracts, connector mappings, and optional emitted events.')
    .option('--endpoint <url>', 'POST sample events to a local event endpoint.')
    .option('--events-file <path>', 'Read actual app-emitted JSONL events and verify the required event contract.')
    .action(async (experimentId: string, opts: { endpoint?: string; eventsFile?: string }) => {
      await wrap('growth instrumentation verify', ctx, async () => {
        await requireInitialized(ctx.getRoot());
        const root = ctx.getRoot();
        const store = new Store(root);
        const exp = await store.getExperiment(experimentId);
        if (!exp) throw new GrowthError('not_found', `Experiment "${experimentId}" not found.`);
        const framework = await detectFramework(root);
        const appUrl = await resolveAppUrl(root, framework);
        const suggestedFiles = await suggestedInstrumentationFiles(root, framework);
        const existingSuggestedFiles = [];
        for (const file of suggestedFiles) {
          try {
            await fs.access(path.join(root, file));
            existingSuggestedFiles.push(file);
          } catch {
            // absence is reported as a warning, not a hard failure
          }
        }
        const taxonomy = await readTaxonomyEvents(root);
        const taxonomyUnlistedEvents = requiredEvents(exp).filter((event) => !taxonomy.has(event));
        const connectors = await listConnectors(root);
        const warnings = [];
        let connectorCoverageOk = true;
        try {
          assertCoverage([exp], connectors);
        } catch {
          connectorCoverageOk = false;
        }
        if (!connectorCoverageOk) {
          warnings.push({
            code: 'CONNECTOR_COVERAGE_GAP',
            message: 'No connector currently maps every event required by this experiment.',
          });
        }
        const endpointCheck = opts.endpoint
          ? await verifyEndpoint(opts.endpoint, sampleEvents(exp))
          : undefined;
        const actualEventCheck = opts.eventsFile
          ? await verifyEventsFile(root, opts.eventsFile, requiredEventSpecs(exp))
          : undefined;
        const instrumentationRun = actualEventCheck
          ? await writeInstrumentationRun(root, exp.id, opts.eventsFile!, actualEventCheck)
          : undefined;
        if (endpointCheck && !endpointCheck.ok) {
          warnings.push(
            ...endpointCheck.results
              .filter((result) => !result.ok)
              .map((result) => ({
                code: 'ENDPOINT_SAMPLE_FAILED',
                message: `${result.event} sample POST failed: ${result.status ?? result.error}`,
              })),
          );
        }
        if (actualEventCheck && !actualEventCheck.ok) {
          warnings.push(
            ...actualEventCheck.missing_events.map((event) => ({
              code: 'ACTUAL_EVENT_MISSING',
              message: `${event} was not observed in ${actualEventCheck.file}.`,
            })),
            ...actualEventCheck.missing_properties.map((missing) => ({
              code: 'ACTUAL_EVENT_PROPERTY_MISSING',
              message: `${missing.event} was observed but is missing required properties: ${missing.properties.join(', ')}.`,
            })),
          );
        }
        const ok =
          connectorCoverageOk &&
          (endpointCheck ? endpointCheck.ok : true) &&
          (actualEventCheck ? actualEventCheck.ok : true);
        const readiness = readinessModel({
          connectorCoverageOk,
          endpointOk: endpointCheck?.ok,
          actualEventOk: actualEventCheck?.ok,
          actualEventProvided: !!actualEventCheck,
        });
        const plan = await resolvePreflightPlan({
          root,
          experiment: exp,
          connectors,
          framework,
          appUrl,
        });
        const assignmentIdentity = assignmentIdentityGuidance(exp);
        const variantIntegrity = variantIntegrityGuidance(exp);
        if (plan.readiness.blocked.length) {
          warnings.push({
            code: 'PREFLIGHT_BLOCKED',
            message: plan.readiness.blocked.join(' '),
          });
        }
        if (assignmentIdentity.status === 'review') {
          warnings.push(assignmentIdentity.warning);
        }
        const readyForPreflight = ok && plan.readiness.current !== 'blocked';
        const readyForPreflightBasis = preflightReadinessBasis(readyForPreflight, readiness);
        if (readyForPreflightBasis === 'static_contract') {
          warnings.push({
            code: 'STATIC_ONLY_PREFLIGHT_READINESS',
            message:
              'Static contract checks passed, but no app-emitted event evidence was verified. Continue through growth preflight plan/run; do not treat this as synthetic evidence.',
          });
        }
        const shouldPlanNext =
          !endpointCheck &&
          !actualEventCheck &&
          (!connectorCoverageOk || ok);
        return {
          data: {
            experiment_id: exp.id,
            framework,
            framework_hint: { detected: framework, advisory_only: true },
            required_events: requiredEvents(exp),
            assignment_identity: assignmentIdentity,
            variant_integrity: variantIntegrity,
            candidate_files: suggestedFiles,
            existing_suggested_files: existingSuggestedFiles,
            taxonomy_unlisted_events: taxonomyUnlistedEvents,
            connector_coverage_ok: connectorCoverageOk,
            endpoint_check: endpointCheck,
            actual_event_check: actualEventCheck,
            instrumentation_run: instrumentationRun,
            static_contract_ok: connectorCoverageOk,
            actual_events_verified: actualEventCheck ? actualEventCheck.ok : false,
            readiness,
            preflight_plan: {
              preferred_evidence: plan.evidence.preferred_evidence,
              readiness_ceiling: plan.evidence.readiness_ceiling,
              blocked: plan.readiness.blocked,
              packet_app_url: plan.packet_app_url,
              next_command: plan.next_command,
            },
            ready_for_preflight: readyForPreflight,
            ready_for_preflight_basis: readyForPreflightBasis,
            static_ready_for_preflight: readyForPreflight && readiness.static_ready,
            emitted_event_ready_for_preflight: readyForPreflight && readiness.local_synthetic_ready,
            ok,
          },
          warnings,
          humanText: ok
            ? actualEventCheck
              ? `Instrumentation contract for ${exp.id} is verified against emitted events.`
              : `Instrumentation contract for ${exp.id} is statically verifiable.`
            : `Instrumentation contract for ${exp.id} has warnings.`,
          nextSteps:
            (endpointCheck && !endpointCheck.ok) ||
            (actualEventCheck && !actualEventCheck.ok)
              ? [
                  'Update connector mappings or app-emitted event payloads as needed.',
                  `Run growth instrumentation verify ${exp.id} --json again.`,
                ]
              : [`Run growth preflight plan ${exp.id} --json`],
          next: shouldPlanNext
            ? {
                command: `growth preflight plan ${exp.id} --json`,
                until: 'Growth chooses evidence source, readiness ceiling, target route, and next command',
              }
            : {
                command: `growth instrumentation verify ${exp.id} --json`,
                until: 'instrumentation contract verifies without warnings',
              },
        };
      });
    });
}

function preflightReadinessBasis(
  readyForPreflight: boolean,
  readiness: ReturnType<typeof readinessModel>,
): 'blocked' | 'static_contract' | 'emitted_synthetic_events' {
  if (!readyForPreflight) return 'blocked';
  return readiness.local_synthetic_ready ? 'emitted_synthetic_events' : 'static_contract';
}

function readinessModel(opts: {
  connectorCoverageOk: boolean;
  endpointOk?: boolean;
  actualEventOk?: boolean;
  actualEventProvided: boolean;
}): {
  tier: ReadinessTier;
  static_ready: boolean;
  local_synthetic_ready: boolean;
  provider_preflight_passed: boolean;
  real_user_analysis_ready: boolean;
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
    real_user_analysis_ready: false,
    notes,
  };
}

function buildContract(exp: Experiment) {
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

type AssignmentIdentityGuidance =
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

function assignmentIdentityGuidance(exp: Experiment): AssignmentIdentityGuidance {
  const stableBy = exp.instrumentation?.assignment?.stable_by ?? 'user_id';
  const evidence = authenticatedTargetingEvidence(exp);
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

function isUserStableKey(stableBy: string): boolean {
  return /^(user_id|user\.id|session\.user\.id)$/.test(stableBy);
}

function variantIntegrityGuidance(exp: Experiment) {
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

function connectorEventShape(connector: ConnectorConfig) {
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

function referenceImplementation(framework: string) {
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
        'Emit PostHog-style envelopes when using the local connector: { event, properties: { ... } }.',
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
        'Emit PostHog-style envelopes when using the local connector: { event, properties: { ... } }.',
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

interface InstrumentationPitfall {
  id: string;
  applies_to: string;
  message: string;
  fix: string;
  evidence?: unknown;
}

function knownPitfalls(spaAgentContext: SpaAgentContextScan, exp: Experiment): InstrumentationPitfall[] {
  const pitfalls: InstrumentationPitfall[] = [
    {
      id: 'variant-field-duality',
      applies_to: 'all',
      message:
        '`variant_id` is the canonical event property. The preflight URL query param is named `variant` only to force synthetic assignment.',
      fix: 'Emit properties.variant_id on every event; optionally emit properties.variant as an alias only for legacy connector compatibility.',
    },
  ];
  const authenticatedEvidence = authenticatedTargetingEvidence(exp);
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
  if (spaAgentContext.uses_client_navigation) {
    pitfalls.unshift({
      id: 'spa-query-string-navigation',
      applies_to: 'client-navigation-detected',
      message:
        'Client-side navigation often drops ?agent_generated, ?agent_run_id, ?experiment_id, and ?variant from the URL.',
      fix: 'Read preflight query params once, persist them to sessionStorage, and attach the persisted values to every emitted event.',
      evidence: spaAgentContext,
    });
  }
  return pitfalls;
}

function requiredEvents(exp: Experiment): string[] {
  return requiredEventSpecs(exp).map((spec) => spec.event);
}

function requiredEventSpecs(exp: Experiment): RequiredEventSpec[] {
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

function sampleEvents(exp: Experiment) {
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

async function verifyEndpoint(endpoint: string, samples: ReturnType<typeof sampleEvents>) {
  const results = [];
  for (const sample of samples) {
    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(sample),
      });
      results.push({
        event: sample.event,
        ok: response.ok,
        status: response.status,
      });
    } catch (err) {
      results.push({
        event: sample.event,
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return {
    endpoint,
    ok: results.every((result) => result.ok),
    results,
  };
}

async function verifyEventsFile(root: string, file: string, specs: RequiredEventSpec[]) {
  const resolved = path.resolve(root, file);
  const raw = await fs.readFile(resolved, 'utf8');
  const observed = new Map<string, Array<Record<string, unknown>>>();
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    const parsed = JSON.parse(line) as Record<string, unknown>;
    const event = typeof parsed.event === 'string' ? parsed.event : undefined;
    if (!event) continue;
    const properties =
      parsed.properties && typeof parsed.properties === 'object'
        ? (parsed.properties as Record<string, unknown>)
        : {};
    observed.set(event, [...(observed.get(event) ?? []), { ...properties, ...parsed }]);
  }

  const missingEvents: string[] = [];
  const missingProperties: Array<{ event: string; properties: string[] }> = [];
  for (const spec of specs) {
    const candidates = observed.get(spec.event) ?? [];
    if (candidates.length === 0) {
      missingEvents.push(spec.event);
      continue;
    }
    const missingByCandidate = candidates.map((candidate) =>
      spec.required_properties.filter((prop) => candidate[prop] === undefined),
    );
    const bestMissing = missingByCandidate.sort((a, b) => a.length - b.length)[0] ?? [];
    if (bestMissing.length > 0) {
      missingProperties.push({
        event: spec.event,
        properties: bestMissing,
      });
    }
  }

  return {
    file: path.relative(root, resolved),
    observed_events: Array.from(observed.keys()).sort(),
    missing_events: missingEvents,
    missing_properties: missingProperties,
    ok: missingEvents.length === 0 && missingProperties.length === 0,
  };
}

async function writeInstrumentationRun(
  root: string,
  experimentId: string,
  eventsFile: string,
  actualEventCheck: Awaited<ReturnType<typeof verifyEventsFile>>,
) {
  const p = paths(root);
  const runId = `instrumentation_${timestampId()}`;
  const runDir = path.join(p.runsDir, runId);
  const resultFile = path.join(runDir, 'verify.json');
  await fs.mkdir(runDir, { recursive: true });
  const run = {
    id: runId,
    type: 'instrumentation',
    experiment_id: experimentId,
    status: actualEventCheck.ok ? 'completed' : 'failed',
    created_at: new Date().toISOString(),
    completed_at: new Date().toISOString(),
    artifacts: {
      events_file: path.relative(root, path.resolve(root, eventsFile)),
      verify_result: path.relative(root, resultFile),
    },
    warnings: [],
  };
  await fs.writeFile(path.join(runDir, 'run.json'), JSON.stringify(run, null, 2) + '\n');
  await fs.writeFile(resultFile, JSON.stringify({ actual_event_check: actualEventCheck }, null, 2) + '\n');
  return {
    id: runId,
    file: path.relative(root, resultFile),
    ok: actualEventCheck.ok,
  };
}

function timestampId(): string {
  return new Date().toISOString().replace(/[-:.]/g, '');
}

async function readTaxonomyEvents(root: string): Promise<Set<string>> {
  try {
    const raw = await fs.readFile(paths(root).eventTaxonomyFile, 'utf8');
    const parsed = JSON.parse(raw) as { events?: Array<{ event?: string }> };
    return new Set((parsed.events ?? []).map((e) => e.event).filter((e): e is string => !!e));
  } catch {
    return new Set();
  }
}
