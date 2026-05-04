/**
 * File-backed experiment store. All paths flow through paths.ts.
 *
 * Layout:
 *   <root>/.growth/experiments/<id>.json     # Experiment configs
 *   <root>/.growth/data/assignments.jsonl
 *   <root>/.growth/data/events.jsonl
 *
 * Append-only event log keeps writes cheap and replays trivial. The
 * documented swap point is replacing this class with a Postgres-backed
 * implementation that exposes the same surface.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import type { ErrorObject } from 'ajv';
import { experimentSchema } from '../domain/schema.js';
import type { Assignment, Experiment, ExperimentEvent } from '../domain/types.js';
import { paths } from './paths.js';
import { readShared, writeShared } from './state.js';
import { GrowthError } from './envelope.js';
import { BUILT_IN_TEMPLATES } from './defaults.js';

const ajv = new (Ajv2020 as unknown as { new (opts: object): Ajv2020 })({
  allErrors: true,
  strict: false,
});
(addFormats as unknown as (a: Ajv2020) => void)(ajv);
const validateExperiment = ajv.compile(experimentSchema);

export class Store {
  readonly p: ReturnType<typeof paths>;

  constructor(readonly root: string) {
    this.p = paths(root);
  }

  // ----- Experiment CRUD -----

  async listExperiments(): Promise<Experiment[]> {
    let files: string[] = [];
    try {
      files = await fs.readdir(this.p.experimentsDir);
    } catch {
      return [];
    }
    const out: Experiment[] = [];
    for (const f of files) {
      if (!f.endsWith('.json')) continue;
      try {
        const raw = await fs.readFile(path.join(this.p.experimentsDir, f), 'utf8');
        out.push(JSON.parse(raw) as Experiment);
      } catch {
        // skip unreadable
      }
    }
    return out.sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
  }

  async getExperiment(id: string): Promise<Experiment | null> {
    const file = path.join(this.p.experimentsDir, `${id}.json`);
    try {
      const raw = await fs.readFile(file, 'utf8');
      return JSON.parse(raw) as Experiment;
    } catch {
      return null;
    }
  }

  async saveExperiment(exp: Experiment): Promise<void> {
    const valid = validateExperiment(exp);
    if (!valid) {
      const errs = (validateExperiment.errors ?? []).map((e: ErrorObject) => ({
        path: e.instancePath || '/',
        message: e.message ?? '',
      }));
      throw new GrowthError(
        'invalid_experiment',
        `Experiment failed schema validation`,
        { errors: errs },
      );
    }
    validateExperimentSemantics(exp);
    await fs.mkdir(this.p.experimentsDir, { recursive: true });
    const file = path.join(this.p.experimentsDir, `${exp.id}.json`);
    await fs.writeFile(file, JSON.stringify(exp, null, 2) + '\n', 'utf8');
    await this.syncSharedExperiment(exp);
  }

  async deleteExperiment(id: string): Promise<boolean> {
    const file = path.join(this.p.experimentsDir, `${id}.json`);
    try {
      await fs.unlink(file);
      await this.removeSharedExperiment(id);
      return true;
    } catch {
      return false;
    }
  }

  private async syncSharedExperiment(exp: Experiment): Promise<void> {
    const shared = await readShared(this.root);
    if (!shared) return;
    shared.experiments[exp.id] = {
      file: path.relative(this.root, path.join(this.p.experimentsDir, `${exp.id}.json`)),
      status: exp.status,
      last_analysis_at: shared.experiments[exp.id]?.last_analysis_at ?? null,
    };
    await writeShared(this.root, shared);
  }

  private async removeSharedExperiment(id: string): Promise<void> {
    const shared = await readShared(this.root);
    if (!shared) return;
    delete shared.experiments[id];
    await writeShared(this.root, shared);
  }

  // ----- Assignments -----

  async appendAssignment(a: Assignment): Promise<void> {
    await fs.mkdir(this.p.dataDir, { recursive: true });
    await fs.appendFile(this.p.assignmentsFile, JSON.stringify(a) + '\n', 'utf8');
  }

  async readAssignments(experimentId: string): Promise<Assignment[]> {
    return readJsonl<Assignment>(this.p.assignmentsFile, (a) => a.experiment_id === experimentId);
  }

  // ----- Events -----

  async appendEvent(e: ExperimentEvent): Promise<void> {
    await fs.mkdir(this.p.dataDir, { recursive: true });
    await fs.appendFile(this.p.eventsFile, JSON.stringify(e) + '\n', 'utf8');
  }

  async appendEvents(events: ExperimentEvent[]): Promise<void> {
    if (!events.length) return;
    await fs.mkdir(this.p.dataDir, { recursive: true });
    await fs.appendFile(
      this.p.eventsFile,
      events.map((e) => JSON.stringify(e)).join('\n') + '\n',
      'utf8',
    );
  }

  async readEvents(experimentId: string): Promise<ExperimentEvent[]> {
    return readJsonl<ExperimentEvent>(this.p.eventsFile, (e) => e.experiment_id === experimentId);
  }

  /**
   * Read every idempotency key we've already ingested. Used by `pull` for
   * idempotency: dedup against this set before appending.
   */
  async readIngestedIdempotencyKeys(): Promise<Set<string>> {
    const set = new Set<string>();
    let raw: string;
    try {
      raw = await fs.readFile(this.p.eventsFile, 'utf8');
    } catch {
      return set;
    }
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      try {
        const parsed = JSON.parse(line) as ExperimentEvent;
        if (parsed.idempotency_key) set.add(parsed.idempotency_key);
      } catch {
        // skip
      }
    }
    return set;
  }

  async clearData(experimentId: string): Promise<void> {
    await rewriteJsonl<Assignment>(
      this.p.assignmentsFile,
      (a) => a.experiment_id !== experimentId,
    );
    await rewriteJsonl<ExperimentEvent>(
      this.p.eventsFile,
      (e) => e.experiment_id !== experimentId,
    );
  }

  // ----- Templates -----

  async listTemplates(): Promise<string[]> {
    const names = new Set(Object.keys(BUILT_IN_TEMPLATES));
    try {
      const files = await fs.readdir(this.p.templatesDir);
      for (const file of files) {
        if (file.endsWith('.json')) names.add(file.replace(/\.json$/, ''));
      }
    } catch {
      // built-ins are still available without local template files
    }
    return Array.from(names).sort();
  }

  async getTemplate(name: string): Promise<Partial<Experiment> | null> {
    const file = path.join(this.p.templatesDir, `${name}.json`);
    try {
      const raw = await fs.readFile(file, 'utf8');
      return JSON.parse(raw) as Partial<Experiment>;
    } catch {
      return BUILT_IN_TEMPLATES[name] ?? null;
    }
  }
}

function validateExperimentSemantics(exp: Experiment): void {
  const errors: Array<{ path: string; message: string }> = [];
  const primaryCount = exp.metrics.filter((m) => m.role === 'primary').length;
  if (primaryCount !== 1) {
    errors.push({ path: '/metrics', message: 'must contain exactly one primary metric' });
  }
  if (exp.variants[0]?.id !== 'control') {
    errors.push({
      path: '/variants/0/id',
      message: 'first variant must be the control variant with id "control"',
    });
  }
  const totalWeight = exp.variants.reduce((sum, v) => sum + v.weight, 0);
  if (totalWeight <= 0) {
    errors.push({ path: '/variants', message: 'variant weights must sum to more than 0' });
  }
  for (const [i, metric] of exp.metrics.entries()) {
    if (metric.role === 'guardrail' && metric.guardrail_threshold === undefined) {
      errors.push({
        path: `/metrics/${i}/guardrail_threshold`,
        message: 'guardrail metrics must define guardrail_threshold',
      });
    }
    if (metric.type === 'proportion' && !metric.denominator_event) {
      errors.push({
        path: `/metrics/${i}/denominator_event`,
        message: 'proportion metrics must define denominator_event',
      });
    }
  }
  if (errors.length) {
    throw new GrowthError('invalid_experiment', 'Experiment failed semantic validation', { errors });
  }
}

async function readJsonl<T>(file: string, filter: (item: T) => boolean): Promise<T[]> {
  let raw: string;
  try {
    raw = await fs.readFile(file, 'utf8');
  } catch {
    return [];
  }
  const out: T[] = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line) as T;
      if (filter(parsed)) out.push(parsed);
    } catch {
      // skip malformed
    }
  }
  return out;
}

async function rewriteJsonl<T>(file: string, keep: (item: T) => boolean): Promise<void> {
  let raw: string;
  try {
    raw = await fs.readFile(file, 'utf8');
  } catch {
    return;
  }
  const kept: string[] = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line) as T;
      if (keep(parsed)) kept.push(line);
    } catch {
      // drop malformed
    }
  }
  await fs.writeFile(file, kept.length ? kept.join('\n') + '\n' : '', 'utf8');
}
