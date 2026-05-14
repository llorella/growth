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
import { assertConnectorCoverage } from '../connectors/coverage.js';
import { connectorAdapterFor, supportedConnectorAdapterKinds } from '../connectors/registry.js';
import { paths } from './paths.js';
import { Store } from './store.js';
import { GrowthError } from './envelope.js';
import {
  getConnector,
  listConnectors,
  type ConnectorConfig,
} from './connectors.js';
import type { Assignment, ExperimentEvent } from '../core/experiment/types.js';

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
  const adapter = connectorAdapterFor(connector);
  if (!adapter) {
    throw new GrowthError(
      'unsupported_connector_kind',
      `Pull for kind "${connector.kind}" is not implemented for this connector.`,
      {
        supported: supportedConnectorAdapterKinds(),
      },
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
  assertConnectorCoverage([experiment], allConnectors);

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

  const raw = await fetchRawEvents(root, connector, adapter, after, before, opts.limit ?? 1000);

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
    const result = adapter.mapEvent(connector, r);
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
  adapter: NonNullable<ReturnType<typeof connectorAdapterFor>>,
  after: string,
  before: string,
  limit: number,
): Promise<unknown[]> {
  return adapter.pullEvents(root, connector, { after, before }, limit);
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
