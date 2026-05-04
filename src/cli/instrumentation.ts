import type { Command } from 'commander';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { wrap, type RunCtx } from '../lib/runner.js';
import { requireInitialized } from '../lib/gating.js';
import { Store } from '../lib/store.js';
import { GrowthError } from '../lib/envelope.js';
import { detectFramework, suggestedInstrumentationFiles } from '../lib/framework.js';
import { listConnectors, assertCoverage, type ConnectorConfig } from '../lib/connectors.js';
import { paths } from '../lib/paths.js';
import type { Experiment } from '../domain/types.js';

const REQUIRED_EVENT_PROPERTIES = [
  'experiment_id',
  'variant',
  'variant_id',
  'user_id',
  'session_id',
  'timestamp',
  'agent_generated',
  'agent_run_id',
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
        return {
          data: {
            framework,
            experiment_id: exp.id,
            required_contract: contract,
            suggested_files: suggestedFiles,
            connector_event_shapes: connectors.map(connectorEventShape),
            preflight_query_params: PREFLIGHT_QUERY_PARAMS,
            reference_implementation: referenceImplementation(framework),
            prompt_packet: {
              summary: `Instrument ${exp.id} so assignments are stable and all required events include the growth properties.`,
              rules: [
                'Read preflight query params before implementing assignment.',
                'Emit events in the shape expected by the active connector paths.',
                'Persist assignment and per-event idempotency keys so rerenders do not duplicate events.',
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
            'Use connector_event_shapes from the JSON output when shaping app events.',
            `Run growth instrumentation verify ${exp.id} --json.`,
          ],
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
    .description('Verify available static contracts, taxonomy, and connector mappings.')
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
        const missingFromTaxonomy = requiredEvents(exp).filter((event) => !taxonomy.has(event));
        const connectors = await listConnectors(root);
        const warnings = [
          ...missingFromTaxonomy.map((event) => ({
            code: 'EVENT_NOT_IN_TAXONOMY',
            message: `${event} is required by ${exp.id} but not listed in .growth/event-taxonomy.json.`,
          })),
          ...(existingSuggestedFiles.length === 0
            ? [
                {
                  code: 'NO_SUGGESTED_FILES_FOUND',
                  message: 'None of the framework-suggested instrumentation files exist yet.',
                },
              ]
            : []),
        ];
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
          missingFromTaxonomy.length === 0 &&
          connectorCoverageOk &&
          (endpointCheck ? endpointCheck.ok : true) &&
          (actualEventCheck ? actualEventCheck.ok : true);
        return {
          data: {
            experiment_id: exp.id,
            framework,
            required_events: requiredEvents(exp),
            existing_suggested_files: existingSuggestedFiles,
            missing_from_taxonomy: missingFromTaxonomy,
            connector_coverage_ok: connectorCoverageOk,
            endpoint_check: endpointCheck,
            actual_event_check: actualEventCheck,
            ok,
          },
          warnings,
          humanText: ok
            ? `Instrumentation contract for ${exp.id} is statically verifiable.`
            : `Instrumentation contract for ${exp.id} has warnings.`,
          nextSteps:
            missingFromTaxonomy.length ||
            !connectorCoverageOk ||
            (endpointCheck && !endpointCheck.ok) ||
            (actualEventCheck && !actualEventCheck.ok)
              ? [
                  'Update .growth/event-taxonomy.json and connector mappings as needed.',
                  `Run growth instrumentation verify ${exp.id} --json again.`,
                ]
              : [`Run growth preflight prepare ${exp.id} --agents 4 --browser --json`],
          next: ok
            ? {
                command: `growth preflight prepare ${exp.id} --agents 4 --browser --json`,
                until: 'browser-agent packets are prepared for pre-launch validation',
              }
            : {
                command: `growth instrumentation verify ${exp.id} --json`,
                until: 'instrumentation contract verifies without warnings',
              },
        };
      });
    });
}

function buildContract(exp: Experiment) {
  return {
    assignment: exp.instrumentation?.assignment ?? {
      stable_by: 'user_id',
      properties: ['experiment_id', 'variant', 'variant_id', 'user_id'],
    },
    events: requiredEventSpecs(exp),
    agent_traffic: {
      required_properties: ['agent_generated', 'agent_run_id'],
      query_params: PREFLIGHT_QUERY_PARAMS,
    },
  };
}

const PREFLIGHT_QUERY_PARAMS = [
  {
    name: 'agent_generated',
    value: 'true',
    meaning: 'Marks browser-agent traffic so analysis can keep it separate from real users.',
  },
  {
    name: 'agent_run_id',
    value: '<preflight_run_id>_agent_<n>',
    meaning: 'Stable synthetic run id. Preserve it on every emitted event.',
  },
  {
    name: 'experiment_id',
    value: '<experiment_id>',
    meaning: 'Experiment being exercised by the preflight packet.',
  },
  {
    name: 'variant',
    value: '<variant_id>',
    meaning: 'Synthetic preflight packets may force a variant to balance test coverage.',
  },
] as const;

function connectorEventShape(connector: ConnectorConfig) {
  const sample: Record<string, unknown> = {};
  if (connector.event_name_path === 'event') sample.event = 'onboarding_started';
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
  if (framework === 'nextjs-app-router') {
    return {
      skill_reference: '.agents/skills/growth/references/nextjs-app-router.md',
      notes: [
        'Read URL params agent_generated, agent_run_id, experiment_id, and variant before hashing assignment.',
        'Only reset synthetic per-event dedupe when agent_run_id changes.',
        'Emit PostHog-style envelopes when using the local connector: { event, properties: { ... } }.',
      ],
    };
  }
  return {
    notes: [
      'Persist assignment by stable id.',
      'Attach preflight query params to every synthetic event.',
      'Emit event payloads that match connector_event_shapes.',
    ],
  };
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
    agent_generated: false,
    agent_run_id: null,
    assignment_id: `assign_${exp.id}_sample`,
    onboarding_step: 'workspace',
    url_path: '/onboarding',
    goal: 'launch',
    workspace_name_present: true,
    invite_count: 1,
    completion_next_action: 'open_dashboard',
    error_code: null,
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

async function readTaxonomyEvents(root: string): Promise<Set<string>> {
  try {
    const raw = await fs.readFile(paths(root).eventTaxonomyFile, 'utf8');
    const parsed = JSON.parse(raw) as { events?: Array<{ event?: string }> };
    return new Set((parsed.events ?? []).map((e) => e.event).filter((e): e is string => !!e));
  } catch {
    return new Set();
  }
}
