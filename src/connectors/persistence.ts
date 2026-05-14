import { promises as fs } from 'node:fs';
import path from 'node:path';
import { GrowthError } from '../lib/envelope.js';
import { isConnectorKind } from '../lib/connector-catalog.js';
import { paths } from '../lib/paths.js';
import { readShared, writeShared } from '../lib/state.js';
import { connectorAdapterFor } from './registry.js';
import type { ConnectorAdapter, ConnectorConfig, ConnectorValidationIssue } from './types.js';

export interface PersistedConnector {
  adapter: ConnectorAdapter;
  source: string;
  connector: ConnectorConfig;
  file: string;
}

export interface PersistConnectorOptions {
  overwrite?: boolean;
  alreadyExistsMessage?: string;
}

export async function persistConnector(
  root: string,
  adapter: ConnectorAdapter,
  source: string,
  connector: ConnectorConfig,
  opts: PersistConnectorOptions = {},
): Promise<PersistedConnector> {
  const p = paths(root);
  await fs.mkdir(p.connectorsDir, { recursive: true });
  const file = path.join(p.connectorsDir, `${source}.json`);
  const existing = await readConnector(root, source);
  if (existing && !opts.overwrite) {
    throw new GrowthError(
      'already_exists',
      opts.alreadyExistsMessage ?? `Connector "${source}" already exists.`,
    );
  }

  await fs.writeFile(file, JSON.stringify(connector, null, 2) + '\n');

  const shared = await readShared(root);
  if (shared) {
    shared.connectors[source] = {
      status: 'configured',
      config_file: path.relative(root, file),
      required_env: adapter.requiredEnv(connector),
      required_scopes: adapter.requiredScopes(connector),
    };
    await writeShared(root, shared);
  }

  return { adapter, source, connector, file };
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

export async function readConnector(root: string, source: string): Promise<ConnectorConfig | null> {
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
