import { GrowthError } from '../lib/envelope.js';
import type { ConnectorConfig } from './types.js';
import {
  connectorAdapterForSource,
  supportedConnectorSources,
} from './registry.js';
import { persistConnector, type PersistedConnector } from './persistence.js';

export interface AddConnectorOptions {
  projectId?: string;
  host?: string;
  apiKeyEnv?: string;
  eventsFile?: string;
  consoleApiKeyEnv?: string;
  mappings?: ConnectorConfig['mappings'];
}

export async function addConnectorFromSource(
  root: string,
  source: string,
  opts: AddConnectorOptions,
): Promise<PersistedConnector> {
  const sourceMatch = connectorAdapterForSource(source);
  if (!sourceMatch) {
    throw new GrowthError('unsupported_connector', 'Connector scaffolding supports the registered connector sources.', {
      supported: supportedConnectorSources(),
    });
  }

  const { adapter, source: normalizedSource } = sourceMatch;
  const connector = adapter.defaultConfig({
    source: normalizedSource,
    projectId: opts.projectId,
    host: opts.host,
    apiKeyEnv: opts.apiKeyEnv,
    eventsFile: opts.eventsFile,
    consoleApiKeyEnv: opts.consoleApiKeyEnv,
    mappings: opts.mappings,
  });

  return persistConnector(root, adapter, normalizedSource, connector);
}
