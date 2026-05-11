/**
 * Connectors map source events (PostHog, Segment, Stripe webhooks, custom)
 * onto framework events. Configs are JSON, agent-editable. Adding a new
 * source = writing a config, not writing code.
 *
 * Improvements over the every-exp version:
 *   - idempotency_key_path is preferred when used by `pull`, with a stable
 *     hash fallback so overlapping windows do not double-count events.
 *   - Field-coverage validation: at pull time we verify every event
 *     referenced by an active experiment has a mapping. Misses fail loudly
 *     instead of silently dropping.
 */
import { promises as fs } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import type { Experiment, ExperimentEvent } from '../domain/types.js';
import { paths } from './paths.js';
import { GrowthError } from './envelope.js';
import { DEFAULT_EVENT_TAXONOMY } from './defaults.js';

export interface ConnectorMapping {
  framework_event?: string;
  payload_paths?: Record<string, string>;
  payload_static?: Record<string, unknown>;
}

export interface ConnectorConfig {
  source: string;
  /** Drives the pull strategy. Pull supports 'posthog' and local JSONL-backed 'native-app'. */
  kind: 'posthog' | 'segment' | 'stripe' | 'native-app' | 'warehouse' | 'custom';
  user_id_path?: string;
  anonymous_id_path?: string;
  experiment_id_path?: string;
  variant_id_path?: string;
  event_name_path?: string;
  idempotency_key_path?: string;
  timestamp_path?: string;
  /** Posthog-specific config block. Other kinds get their own block. */
  posthog?: {
    host?: string;
    project_id: string | number;
    api_key_env?: string;
  };
  /** Native/local app event stream config. events_file is JSONL relative to the repo root unless absolute. */
  local?: {
    events_file: string;
  };
  mappings: Record<string, ConnectorMapping>;
}

export interface ConnectorValidationIssue {
  source: string;
  message: string;
  path?: string;
}

const CONNECTOR_KINDS = new Set(['posthog', 'segment', 'stripe', 'native-app', 'warehouse', 'custom']);

export async function listConnectors(root: string): Promise<ConnectorConfig[]> {
  const dir = paths(root).connectorsDir;
  let files: string[] = [];
  try {
    files = await fs.readdir(dir);
  } catch {
    return [];
  }
  const out: ConnectorConfig[] = [];
  for (const f of files) {
    if (!f.endsWith('.json')) continue;
    try {
      const raw = await fs.readFile(path.join(dir, f), 'utf8');
      out.push(JSON.parse(raw) as ConnectorConfig);
    } catch {
      // skip malformed
    }
  }
  return out;
}

export async function getConnector(root: string, source: string): Promise<ConnectorConfig | null> {
  const file = path.join(paths(root).connectorsDir, `${source}.json`);
  try {
    const raw = await fs.readFile(file, 'utf8');
    return JSON.parse(raw) as ConnectorConfig;
  } catch {
    return null;
  }
}

export function validateConnectorConfig(connector: ConnectorConfig): ConnectorValidationIssue[] {
  const issues: ConnectorValidationIssue[] = [];
  const source = typeof connector.source === 'string' && connector.source ? connector.source : '(unknown)';
  const requiredStringFields = ['source', 'event_name_path', 'user_id_path', 'experiment_id_path', 'variant_id_path'];
  for (const field of requiredStringFields) {
    const value = (connector as unknown as Record<string, unknown>)[field];
    if (typeof value !== 'string' || value.length === 0) {
      issues.push({ source, message: `missing ${field}`, path: field });
    }
  }
  if (!CONNECTOR_KINDS.has(connector.kind)) {
    issues.push({ source, message: `unsupported kind ${String(connector.kind)}`, path: 'kind' });
  }
  if (connector.kind === 'posthog') {
    if (!isRecord(connector.posthog)) {
      issues.push({ source, message: 'missing posthog config block', path: 'posthog' });
    } else {
      if (typeof connector.posthog.project_id !== 'string' && typeof connector.posthog.project_id !== 'number') {
        issues.push({ source, message: 'missing posthog.project_id', path: 'posthog.project_id' });
      }
      if (connector.posthog.host !== undefined && typeof connector.posthog.host !== 'string') {
        issues.push({ source, message: 'posthog.host must be a string', path: 'posthog.host' });
      }
      if (connector.posthog.api_key_env !== undefined && typeof connector.posthog.api_key_env !== 'string') {
        issues.push({ source, message: 'posthog.api_key_env must be a string', path: 'posthog.api_key_env' });
      }
    }
  }
  if (connector.kind === 'native-app') {
    if (!isRecord(connector.local) || typeof connector.local.events_file !== 'string' || connector.local.events_file.length === 0) {
      issues.push({ source, message: 'missing local.events_file', path: 'local.events_file' });
    }
  }
  if (!isRecord(connector.mappings)) {
    issues.push({ source, message: 'missing mappings object', path: 'mappings' });
    return issues;
  }
  for (const [eventName, mapping] of Object.entries(connector.mappings)) {
    const basePath = `mappings.${eventName}`;
    if (!isRecord(mapping)) {
      issues.push({ source, message: 'mapping must be an object', path: basePath });
      continue;
    }
    const frameworkEvent = mapping.framework_event;
    if (frameworkEvent !== undefined && typeof frameworkEvent !== 'string') {
      issues.push({ source, message: 'framework_event must be a string', path: `${basePath}.framework_event` });
    }
    if (mapping.payload_paths !== undefined) {
      if (!isRecord(mapping.payload_paths)) {
        issues.push({ source, message: 'payload_paths must be an object', path: `${basePath}.payload_paths` });
      } else {
        for (const [key, value] of Object.entries(mapping.payload_paths)) {
          if (typeof value !== 'string' || value.length === 0) {
            issues.push({ source, message: `payload path for ${key} must be a string`, path: `${basePath}.payload_paths.${key}` });
          }
        }
      }
    }
    if (mapping.payload_static !== undefined && !isRecord(mapping.payload_static)) {
      issues.push({ source, message: 'payload_static must be an object', path: `${basePath}.payload_static` });
    }
  }
  return issues;
}

/**
 * Verify every event referenced by an active (non-stopped, non-completed)
 * experiment has a mapping somewhere across the loaded connectors. Throws
 * if any event is unmapped - pull would silently drop those events otherwise.
 */
export function assertCoverage(
  experiments: Experiment[],
  connectors: ConnectorConfig[],
): void {
  const required = new Set<string>();
  for (const exp of experiments) {
    if (exp.status === 'stopped' || exp.status === 'completed') continue;
    for (const event of requiredExperimentEvents(exp)) required.add(event);
  }
  const provided = new Set<string>();
  for (const c of connectors) {
    for (const [src, rule] of Object.entries(c.mappings)) {
      provided.add(rule.framework_event ?? src);
    }
  }
  const missing: string[] = [];
  for (const e of required) {
    if (!provided.has(e)) missing.push(e);
  }
  if (missing.length > 0) {
    throw new GrowthError(
      'connector_coverage_gap',
      `${missing.length} event(s) referenced by active experiments have no connector mapping.`,
      { missing, hint: 'Add framework_event mappings in .growth/connectors/*.json.' },
    );
  }
}

/**
 * Read a dot-path from an arbitrary JSON object. Supports `[n]` array indexing.
 */
export function readPath(obj: unknown, p: string): unknown {
  const parts = p.split('.').flatMap((seg) => {
    const m = seg.match(/^([^[]+)((?:\[\d+\])*)$/);
    if (!m) return [seg];
    const indices = (m[2].match(/\[\d+\]/g) ?? []).map((s) => parseInt(s.slice(1, -1), 10));
    return [m[1], ...indices.map((i) => `__idx${i}`)];
  });
  let cur: unknown = obj;
  for (const part of parts) {
    if (cur == null) return undefined;
    if (typeof part === 'string' && part.startsWith('__idx')) {
      const i = parseInt(part.slice(5), 10);
      if (!Array.isArray(cur)) return undefined;
      cur = cur[i];
    } else if (typeof cur === 'object') {
      cur = (cur as Record<string, unknown>)[part];
    } else {
      return undefined;
    }
  }
  return cur;
}

/**
 * Apply a connector to a raw source event, producing 0 or 1 framework event.
 * Returns null if the event should be dropped, with a reason for diagnostics.
 */
export interface MapResult {
  event?: ExperimentEvent;
  drop_reason?: string;
}

export function mapEvent(connector: ConnectorConfig, raw: unknown): MapResult {
  const eventName = connector.event_name_path
    ? (readPath(raw, connector.event_name_path) as string | undefined)
    : undefined;
  if (!eventName) return { drop_reason: 'missing_event_name' };

  const rule = connector.mappings[eventName];
  if (!rule) return { drop_reason: `unmapped:${eventName}` };

  const explicitUserId = connector.user_id_path
    ? (readPath(raw, connector.user_id_path) as string | undefined)
    : undefined;
  const anonymousId = connector.anonymous_id_path
    ? (readPath(raw, connector.anonymous_id_path) as string | undefined)
    : undefined;
  const userId = explicitUserId ?? anonymousId;
  if (!userId) return { drop_reason: 'missing_user_id' };

  const experimentId = connector.experiment_id_path
    ? (readPath(raw, connector.experiment_id_path) as string | undefined)
    : undefined;
  if (!experimentId) return { drop_reason: 'missing_experiment_id' };

  const variantId = readVariantId(connector, raw);
  if (!variantId) return { drop_reason: 'missing_variant_id' };

  const idempotencyKey = connector.idempotency_key_path
    ? (readPath(raw, connector.idempotency_key_path) as string | undefined)
    : undefined;

  const timestamp = connector.timestamp_path
    ? (readPath(raw, connector.timestamp_path) as string | undefined)
    : (readPath(raw, 'timestamp') as string | undefined);

  const payload: Record<string, unknown> = {};
  if (rule.payload_paths) {
    for (const [k, p] of Object.entries(rule.payload_paths)) {
      const v = readPath(raw, p);
      if (v !== undefined) payload[k] = v;
    }
  }
  if (rule.payload_static) Object.assign(payload, rule.payload_static);

  return {
    event: {
      experiment_id: experimentId,
      user_id: userId,
      anonymous_id: anonymousId,
      variant_id: variantId,
      event: rule.framework_event ?? eventName,
      timestamp: timestamp ?? new Date().toISOString(),
      source: connector.source,
      payload: Object.keys(payload).length ? payload : undefined,
      idempotency_key:
        idempotencyKey ??
        stableEventKey(
          connector.source,
          experimentId,
          userId,
          variantId,
          rule.framework_event ?? eventName,
          timestamp,
          payload,
        ),
    },
  };
}

export function defaultPostHogConnector(projectId: string | number = 'POSTHOG_PROJECT_ID'): ConnectorConfig {
  return {
    source: 'posthog',
    kind: 'posthog',
    user_id_path: 'distinct_id',
    anonymous_id_path: 'properties.$anon_distinct_id',
    experiment_id_path: 'properties.experiment_id',
    variant_id_path: 'properties.variant_id',
    event_name_path: 'event',
    timestamp_path: 'timestamp',
    idempotency_key_path: 'uuid',
    posthog: {
      host: 'https://us.posthog.com',
      project_id: projectId,
      api_key_env: 'POSTHOG_PERSONAL_API_KEY',
    },
    mappings: {},
  };
}

function readVariantId(connector: ConnectorConfig, raw: unknown): string | undefined {
  const configured = connector.variant_id_path
    ? (readPath(raw, connector.variant_id_path) as string | undefined)
    : undefined;
  if (configured) return configured;
  if (connector.variant_id_path === 'properties.variant_id') {
    return readPath(raw, 'properties.variant') as string | undefined;
  }
  return undefined;
}

export function defaultLocalConnector(eventsFile = 'tmp/events.jsonl'): ConnectorConfig {
  return {
    source: 'local',
    kind: 'native-app',
    user_id_path: 'properties.user_id',
    anonymous_id_path: 'properties.anonymous_id',
    experiment_id_path: 'properties.experiment_id',
    variant_id_path: 'properties.variant_id',
    event_name_path: 'event',
    timestamp_path: 'properties.timestamp',
    idempotency_key_path: 'properties.event_id',
    local: {
      events_file: eventsFile,
    },
    mappings: Object.fromEntries(
      DEFAULT_EVENT_TAXONOMY.events.map((event) => [
        event.event,
        {
          framework_event: event.event,
          payload_paths: {
            agent_generated: 'properties.agent_generated',
            agent_run_id: 'properties.agent_run_id',
            session_id: 'properties.session_id',
          },
        },
      ]),
    ),
  };
}

function requiredExperimentEvents(exp: Experiment): string[] {
  const out = new Set<string>();
  for (const metric of exp.metrics) {
    out.add(metric.event);
    if (metric.denominator_event) out.add(metric.denominator_event);
  }
  for (const event of exp.instrumentation?.events ?? []) {
    out.add(event.event);
  }
  return Array.from(out);
}

function stableEventKey(
  source: string,
  experimentId: string,
  userId: string,
  variantId: string,
  event: string,
  timestamp: string | undefined,
  payload: Record<string, unknown>,
): string {
  const body = JSON.stringify({
    source,
    experiment_id: experimentId,
    user_id: userId,
    variant_id: variantId,
    event,
    timestamp,
    payload: sortObject(payload),
  });
  return createHash('sha256').update(body).digest('hex');
}

function sortObject(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortObject);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => [k, sortObject(v)]),
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
