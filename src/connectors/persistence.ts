import { promises as fs } from 'node:fs';
import path from 'node:path';
import { GrowthError } from '../lib/envelope.js';
import { getConnector, type ConnectorConfig } from '../lib/connectors.js';
import { paths } from '../lib/paths.js';
import { readShared, writeShared } from '../lib/state.js';
import type { ConnectorAdapter } from './types.js';

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
  const existing = await getConnector(root, source);
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
