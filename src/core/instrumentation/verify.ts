import { promises as fs } from 'node:fs';
import path from 'node:path';
import { paths } from '../../lib/paths.js';
import type { RequiredEventSpec, sampleEvents } from './contracts.js';

export async function verifyEndpoint(endpoint: string, samples: ReturnType<typeof sampleEvents>) {
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

export async function verifyEventsFile(root: string, file: string, specs: RequiredEventSpec[]) {
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

export async function writeInstrumentationRun(
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

export async function readTaxonomyEvents(root: string): Promise<Set<string>> {
  try {
    const raw = await fs.readFile(paths(root).eventTaxonomyFile, 'utf8');
    const parsed = JSON.parse(raw) as { events?: Array<{ event?: string }> };
    return new Set((parsed.events ?? []).map((e) => e.event).filter((e): e is string => !!e));
  } catch {
    return new Set();
  }
}

function timestampId(): string {
  return new Date().toISOString().replace(/[-:.]/g, '');
}
