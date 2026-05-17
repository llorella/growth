import { promises as fs } from 'node:fs';
import path from 'node:path';
import { assertConnectorCoverage } from '../../connectors/coverage.js';
import { resolvePreflightPlan } from '../preflight/plan.js';
import { SYNTHETIC_TRAFFIC_QUERY_PARAMS } from '../evidence/synthetic-traffic.js';
import { GrowthError } from '../../lib/envelope.js';
import { readEnvValue } from '../../lib/env-files.js';
import { resolveAppUrl } from '../../lib/app-url.js';
import { listConnectors } from '../../connectors/persistence.js';
import { suggestedInstrumentationFiles, type FrameworkId } from '../../lib/framework.js';
import { readProjectProfile } from '../../lib/project-profile.js';
import { Store } from '../../lib/store.js';
import {
  assignmentIdentityGuidance,
  buildContract,
  connectorEventShape,
  knownPitfalls,
  preflightReadinessBasis,
  readinessModel,
  referenceImplementation,
  requiredEvents,
  requiredEventSpecs,
  sampleEvents,
  variantIntegrityGuidance,
} from './contracts.js';
import {
  readTaxonomyEvents,
  verifyEndpoint,
  verifyEventsFile,
  writeInstrumentationRun,
} from './verify.js';

export interface InstrumentationVerifyOptions {
  endpoint?: string;
  eventsFile?: string;
}

export async function planInstrumentation(root: string, experimentId: string) {
  const store = new Store(root);
  const exp = await store.getExperiment(experimentId);
  if (!exp) throw new GrowthError('not_found', `Experiment "${experimentId}" not found.`);
  const projectProfile = await readProjectProfile(root);
  const framework = (projectProfile.framework?.id ?? 'unknown') as FrameworkId;
  const contract = buildContract(exp);
  const suggestedFiles = await suggestedInstrumentationFiles(root, framework);
  const connectors = await listConnectors(root);
  const appUrl = await resolveAppUrl(root, framework);
  const assignmentIdentity = assignmentIdentityGuidance(exp, projectProfile);
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
      known_pitfalls: knownPitfalls(exp, connectors[0], projectProfile),
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
}

export async function listInstrumentationEvents(root: string, experimentId: string) {
  const exp = await requireExperiment(root, experimentId);
  return {
    data: { events: requiredEvents(exp) },
    humanText: requiredEvents(exp).map((e) => `  ${e}`).join('\n'),
  };
}

export async function sampleInstrumentationEvents(root: string, experimentId: string) {
  const exp = await requireExperiment(root, experimentId);
  const samples = sampleEvents(exp);
  return {
    data: { samples },
    humanText: JSON.stringify(samples, null, 2),
  };
}

export async function verifyInstrumentation(root: string, experimentId: string, opts: InstrumentationVerifyOptions) {
  const store = new Store(root);
  const exp = await store.getExperiment(experimentId);
  if (!exp) throw new GrowthError('not_found', `Experiment "${experimentId}" not found.`);
  const projectProfile = await readProjectProfile(root);
  const framework = (projectProfile.framework?.id ?? 'unknown') as FrameworkId;
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
    assertConnectorCoverage([exp], connectors);
  } catch {
    connectorCoverageOk = false;
  }
  if (!connectorCoverageOk) {
    warnings.push({
      code: 'CONNECTOR_COVERAGE_GAP',
      message: 'No connector currently maps every event required by this experiment.',
    });
  }
  const posthogConnector = connectors.find((c) => c.kind === 'posthog');
  if (posthogConnector && framework.startsWith('nextjs')) {
    const clientTokenEnv = 'NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN';
    const clientToken = await readEnvValue(root, clientTokenEnv);
    if (!clientToken) {
      warnings.push({
        code: 'MISSING_CLIENT_ENV',
        message: `Next.js client-side PostHog capture requires ${clientTokenEnv} to be set. Without it, posthog-js will not initialize and no browser events will be captured.`,
      });
    }
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
    projectProfile,
    appUrl,
  });
  const assignmentIdentity = assignmentIdentityGuidance(exp, projectProfile);
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
}

async function requireExperiment(root: string, experimentId: string) {
  const store = new Store(root);
  const exp = await store.getExperiment(experimentId);
  if (!exp) throw new GrowthError('not_found', `Experiment "${experimentId}" not found.`);
  return exp;
}
