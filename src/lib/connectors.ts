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
import path from 'node:path';
import { paths } from './paths.js';
import { GrowthError } from './envelope.js';
import { isConnectorKind } from './connector-catalog.js';
import { connectorAdapterFor } from '../connectors/registry.js';
import type { ConnectorValidationIssue } from '../connectors/types.js';
export { assertConnectorCoverage as assertCoverage } from '../connectors/coverage.js';
export { mapConnectorEvent as mapEvent, readConnectorPath as readPath } from '../connectors/mapping.js';
export type { ConnectorMapResult as MapResult } from '../connectors/types.js';
export type { ConnectorValidationIssue } from '../connectors/types.js';

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
    project_id?: string | number;
    api_key_env?: string;
  };
  /** Native/local app event stream config. events_file is JSONL relative to the repo root unless absolute. */
  local?: {
    events_file: string;
  };
  mappings: Record<string, ConnectorMapping>;
}

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
  if (!isConnectorKind(connector.kind)) {
    issues.push({ source, message: `unsupported kind ${String(connector.kind)}`, path: 'kind' });
  }
  issues.push(...(connectorAdapterFor(connector)?.validateConfig(connector) ?? []));
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
