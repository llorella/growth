/**
 * Idempotent pull from external sources. Supports PostHog and local JSONL
 * event streams produced by native app instrumentation.
 *
 * Idempotency contract: re-running with the same `--after` window yields
 * 0 new events because every event is dedup'd by idempotency_key against
 * the existing events.jsonl. Cursors track the highwater timestamp so the
 * default next pull starts where the previous one ended.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { paths } from './paths.js';
import { Store } from './store.js';
import { GrowthError } from './envelope.js';
import {
  getConnector,
  listConnectors,
  assertCoverage,
  mapEvent,
  readPath,
  type ConnectorConfig,
} from './connectors.js';
import { POSTHOG_DEFAULT_API_KEY_ENV, POSTHOG_DEFAULT_HOST, connectorApiKeyEnv } from './connector-catalog.js';
import { readEnvValue } from './env-files.js';
import type { Assignment, ExperimentEvent } from '../domain/types.js';
import { containsTimestamp } from '../domain/event-window.js';

export interface PullCursors {
  [source: string]: {
    [experimentId: string]: {
      last_pulled_at: string;
      highwater_timestamp: string;
    };
  };
}

async function readCursors(root: string): Promise<PullCursors> {
  try {
    const raw = await fs.readFile(paths(root).pullCursorsFile, 'utf8');
    return JSON.parse(raw) as PullCursors;
  } catch {
    return {};
  }
}

async function writeCursors(root: string, cursors: PullCursors): Promise<void> {
  const p = paths(root);
  await fs.mkdir(p.dataDir, { recursive: true });
  await fs.writeFile(p.pullCursorsFile, JSON.stringify(cursors, null, 2) + '\n');
}

export interface PullOptions {
  experimentId: string;
  source: string;
  /** ISO timestamp; defaults to last highwater if cursor exists, else 24h ago. */
  after?: string;
  /** ISO timestamp; defaults to now. */
  before?: string;
  /** Per-event-name page size cap. */
  limit?: number;
  /** Existing run to attach pull artifacts to, for example a preflight run. */
  runId?: string;
  /** Allow a pull window that overlaps a prior recorded pull. */
  allowOverlap?: boolean;
}

export interface PullResult {
  source: string;
  experiment_id: string;
  run_id: string;
  pull_file: string;
  window: { after: string; before: string };
  raw_fetched: number;
  emitted: number;
  deduped: number;
  dropped: { reason: string; count: number }[];
  per_experiment: Record<string, { events: number; new_assignments: number }>;
}

interface PullRecord extends PullResult {
  created_at: string;
}

export async function pull(root: string, opts: PullOptions): Promise<PullResult> {
  const store = new Store(root);

  const connector = await getConnector(root, opts.source);
  if (!connector) {
    throw new GrowthError(
      'connector_not_found',
      `No connector at .growth/connectors/${opts.source}.json.`,
    );
  }

  // Coverage check across all active experiments before fetching anything -
  // catches missing field mappings before they become silent drops.
  const [experiments, allConnectors] = await Promise.all([
    store.listExperiments(),
    listConnectors(root),
  ]);
  const experiment = experiments.find((e) => e.id === opts.experimentId);
  if (!experiment) {
    throw new GrowthError('not_found', `Experiment "${opts.experimentId}" not found.`);
  }
  assertCoverage([experiment], allConnectors);

  const cursors = await readCursors(root);
  const before = opts.before ?? new Date().toISOString();
  const cursorHighwater = cursors[opts.source]?.[opts.experimentId]?.highwater_timestamp;
  const after = opts.after ?? cursorHighwater ?? new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

  const overlap = await findOverlappingPull(root, opts.experimentId, opts.source, {
    after,
    before,
  });
  if (overlap && !opts.allowOverlap) {
    throw new GrowthError(
      'overlapping_pull_window',
      'This pull overlaps a previous pull for the same experiment and source.',
      {
        experiment_id: opts.experimentId,
        source: opts.source,
        requested_window: { after, before },
        overlapping_window: overlap.window,
        overlapping_pull_file: overlap.pull_file,
        hint: 'Pass --yes to intentionally re-pull an overlapping window. Events remain deduped by idempotency_key.',
      },
    );
  }

  const raw = await fetchRawEvents(root, connector, after, before, opts.limit ?? 1000);

  // Pre-load assignments per experiment so we can lazily extend without re-reading.
  const ingestedIds = await store.readIngestedIdempotencyKeys();
  const expIds = new Set([experiment.id]);
  const assignmentsCache = new Map<string, Map<string, string>>();
  for (const e of experiments) {
    const list = await store.readAssignments(e.id);
    const m = new Map<string, string>();
    for (const a of list) m.set(a.user_id, a.variant_id);
    assignmentsCache.set(e.id, m);
  }

  const droppedCounts: Record<string, number> = {};
  const note = (r: string) => (droppedCounts[r] = (droppedCounts[r] ?? 0) + 1);

  const newEvents: ExperimentEvent[] = [];
  const newAssignments: Assignment[] = [];
  const perExp: Record<string, { events: number; new_assignments: number }> = {};
  const perExpTouch = (id: string) => {
    if (!perExp[id]) perExp[id] = { events: 0, new_assignments: 0 };
    return perExp[id];
  };
  let highwater = cursors[opts.source]?.[opts.experimentId]?.highwater_timestamp ?? '';
  let deduped = 0;

  for (const r of raw) {
    const result = mapEvent(connector, r);
    if (result.drop_reason) {
      note(result.drop_reason);
      continue;
    }
    const ev = result.event!;
    if (!expIds.has(ev.experiment_id)) {
      note(`unknown_experiment:${ev.experiment_id}`);
      continue;
    }
    if (ev.idempotency_key && ingestedIds.has(ev.idempotency_key)) {
      deduped += 1;
      continue;
    }
    if (ev.idempotency_key) ingestedIds.add(ev.idempotency_key);

    // Auto-create assignment if first time seeing this user in this experiment.
    const expAssignments = assignmentsCache.get(ev.experiment_id)!;
    if (!expAssignments.has(ev.user_id)) {
      newAssignments.push({
        experiment_id: ev.experiment_id,
        user_id: ev.user_id,
        anonymous_id: ev.anonymous_id,
        variant_id: ev.variant_id,
        assigned_at: ev.timestamp,
        source: opts.source,
      });
      expAssignments.set(ev.user_id, ev.variant_id);
      perExpTouch(ev.experiment_id).new_assignments += 1;
    }

    newEvents.push(ev);
    perExpTouch(ev.experiment_id).events += 1;
    if (ev.timestamp > highwater) highwater = ev.timestamp;
  }

  for (const a of newAssignments) await store.appendAssignment(a);
  if (newEvents.length) await store.appendEvents(newEvents);

  const newHighwater = highwater || before;
  cursors[opts.source] = {
    ...(cursors[opts.source] ?? {}),
    [opts.experimentId]: {
    last_pulled_at: new Date().toISOString(),
    highwater_timestamp: newHighwater,
    },
  };
  await writeCursors(root, cursors);

  const artifact = await writePullRecord(root, opts.runId, {
    source: opts.source,
    experiment_id: opts.experimentId,
    run_id: opts.runId ?? '',
    pull_file: '',
    window: { after, before },
    raw_fetched: raw.length,
    emitted: newEvents.length,
    deduped,
    dropped: Object.entries(droppedCounts).map(([reason, count]) => ({ reason, count })),
    per_experiment: perExp,
  });

  return artifact;
}

async function fetchRawEvents(
  root: string,
  connector: ConnectorConfig,
  after: string,
  before: string,
  limit: number,
): Promise<unknown[]> {
  if (connector.kind === 'posthog') {
    return fetchPostHog(root, connector, after, before, limit);
  }
  if (connector.kind === 'native-app' && connector.local) {
    return fetchLocalJsonl(root, connector, after, before, limit);
  }
  throw new GrowthError(
    'unsupported_connector_kind',
    `Pull for kind "${connector.kind}" is not implemented for this connector.`,
    {
      supported: ['posthog', 'native-app with local.events_file'],
    },
  );
}

async function fetchLocalJsonl(
  root: string,
  connector: ConnectorConfig,
  after: string,
  before: string,
  limit: number,
): Promise<unknown[]> {
  const configuredFile = connector.local?.events_file;
  if (!configuredFile) {
    throw new GrowthError(
      'connector_misconfigured',
      'native-app local pull requires local.events_file in the connector config.',
    );
  }
  const file = path.isAbsolute(configuredFile) ? configuredFile : path.join(root, configuredFile);
  let raw: string;
  try {
    raw = await fs.readFile(file, 'utf8');
  } catch {
    throw new GrowthError(
      'local_events_file_not_found',
      `Local events file not found: ${path.relative(root, file)}`,
      { file: path.relative(root, file) },
    );
  }

  const window = { after, before };
  const out: unknown[] = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    const timestamp = connector.timestamp_path
      ? readPath(parsed, connector.timestamp_path)
      : readPath(parsed, 'timestamp');
    const timestampCheck = containsTimestamp(
      window,
      typeof timestamp === 'string' ? timestamp : undefined,
    );
    if (!timestampCheck.inside) continue;
    out.push(parsed);
    if (out.length >= limit) break;
  }
  return out;
}

async function writePullRecord(
  root: string,
  runId: string | undefined,
  result: PullResult,
): Promise<PullResult> {
  const p = paths(root);
  const id = runId ?? `pull_${timestampId()}`;
  const runDir = path.join(p.runsDir, id);
  const pullsDir = path.join(runDir, 'pulls');
  await fs.mkdir(pullsDir, { recursive: true });
  const file = path.join(
    pullsDir,
    `${result.source}-${timestampId()}.json`,
  );
  const next: PullRecord = {
    ...result,
    run_id: id,
    pull_file: path.relative(root, file),
    created_at: new Date().toISOString(),
  };
  await fs.writeFile(file, JSON.stringify(next, null, 2) + '\n');

  const runFile = path.join(runDir, 'run.json');
  try {
    await fs.access(runFile);
  } catch {
    await fs.writeFile(
      runFile,
      JSON.stringify(
        {
          id,
          type: 'pull',
          experiment_id: result.experiment_id,
          status: 'completed',
          created_at: next.created_at,
          started_at: next.created_at,
          completed_at: next.created_at,
          event_window: result.window,
          artifacts: {
            pull_file: next.pull_file,
          },
          warnings: [],
        },
        null,
        2,
      ) + '\n',
    );
  }

  return next;
}

async function findOverlappingPull(
  root: string,
  experimentId: string,
  source: string,
  window: { after: string; before: string },
): Promise<PullRecord | null> {
  const records = await readPullRecords(root);
  return (
    records.find(
      (record) =>
        record.experiment_id === experimentId &&
        record.source === source &&
        windowsOverlap(record.window, window),
    ) ?? null
  );
}

async function readPullRecords(root: string): Promise<PullRecord[]> {
  const p = paths(root);
  const out: PullRecord[] = [];
  let runs: string[] = [];
  try {
    runs = await fs.readdir(p.runsDir);
  } catch {
    return out;
  }
  for (const run of runs) {
    const pullsDir = path.join(p.runsDir, run, 'pulls');
    let files: string[] = [];
    try {
      files = await fs.readdir(pullsDir);
    } catch {
      continue;
    }
    for (const file of files) {
      if (!file.endsWith('.json')) continue;
      try {
        const parsed = JSON.parse(await fs.readFile(path.join(pullsDir, file), 'utf8')) as PullRecord;
        out.push(parsed);
      } catch {
        // skip malformed pull records
      }
    }
  }
  return out;
}

function windowsOverlap(
  a: { after: string; before: string },
  b: { after: string; before: string },
): boolean {
  const aStart = new Date(a.after).getTime();
  const aEnd = new Date(a.before).getTime();
  const bStart = new Date(b.after).getTime();
  const bEnd = new Date(b.before).getTime();
  return aStart < bEnd && bStart < aEnd;
}

function timestampId(): string {
  return new Date().toISOString().replace(/[-:.]/g, '');
}

async function fetchPostHog(
  root: string,
  connector: ConnectorConfig,
  after: string,
  before: string,
  limit: number,
): Promise<unknown[]> {
  if (!connector.posthog) {
    throw new GrowthError(
      'connector_misconfigured',
      'posthog connector is missing the `posthog` config block (host, project_id, api_key_env).',
    );
  }
  const apiKeyEnv = connectorApiKeyEnv(connector) ?? POSTHOG_DEFAULT_API_KEY_ENV;
  const apiKey = await readEnvValue(root, apiKeyEnv);
  if (!apiKey) {
    throw new GrowthError(
      'missing_api_key',
      `Set ${apiKeyEnv} to the PostHog API key configured for this app.`,
    );
  }
  const host = connector.posthog.host ?? POSTHOG_DEFAULT_HOST;
  const configuredProjectId = connector.posthog.project_id;
  if (configuredProjectId === undefined) {
    throw new GrowthError(
      'missing_project_id',
      'PostHog event pulls require a project id. The analytics API key and host are enough to configure app telemetry, but not enough for this pull API.',
    );
  }
  const projectId =
    typeof configuredProjectId === 'string' && (await readEnvValue(root, configuredProjectId))
      ? await readEnvValue(root, configuredProjectId)
      : configuredProjectId;

  const eventNames = Object.keys(connector.mappings);
  const results: unknown[] = [];
  for (const eventName of eventNames) {
    const params = new URLSearchParams({ event: eventName, limit: String(limit) });
    params.set('after', after);
    params.set('before', before);

    let url: string | null = `${host}/api/projects/${projectId}/events/?${params.toString()}`;
    while (url) {
      const res = await fetch(url, { headers: { Authorization: `Bearer ${apiKey}` } });
      if (!res.ok) {
        const text = await res.text();
        throw new GrowthError(
          'posthog_api_error',
          `PostHog API error ${res.status}`,
          { status: res.status, body: text.slice(0, 500) },
        );
      }
      const body = (await res.json()) as { results: unknown[]; next: string | null };
      results.push(...body.results);
      url = body.next && results.length < limit * eventNames.length ? body.next : null;
    }
  }
  return results;
}
