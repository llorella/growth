import { GrowthError } from '../lib/envelope.js';
import { getConnector, type ConnectorConfig } from '../lib/connectors.js';
import {
  connectorAdapterForImportProvider,
  supportedConnectorImportProviders,
} from './registry.js';
import type { ConnectorAdapter } from './types.js';
import { persistConnector } from './persistence.js';

export interface PersistedConnectorImport {
  adapter: ConnectorAdapter;
  source: string;
  connector: ConnectorConfig;
  file: string;
  imported_from: string;
}

export async function importConnectorFromProvider(
  root: string,
  provider: string,
  opts: { overwrite: boolean },
): Promise<PersistedConnectorImport> {
  const adapter = connectorAdapterForImportProvider(provider);
  if (!adapter?.importConnector) {
    throw new GrowthError('unsupported_import_provider', `Provider "${provider}" is not supported.`, {
      supported: supportedConnectorImportProviders(),
    });
  }

  const source = adapter.defaultSource;
  const existing = await getConnector(root, source);
  if (existing && !opts.overwrite) {
    throw new GrowthError('already_exists', `Connector "${source}" already exists. Pass --yes to overwrite it.`);
  }

  const imported = await adapter.importConnector(root, { provider, existing: existing ?? undefined });
  const persisted = await persistConnector(root, adapter, imported.source, imported.connector, {
    overwrite: opts.overwrite,
    alreadyExistsMessage: `Connector "${imported.source}" already exists. Pass --yes to overwrite it.`,
  });

  return {
    adapter,
    source: imported.source,
    connector: imported.connector,
    file: persisted.file,
    imported_from: imported.imported_from,
  };
}

export async function importConnectorFromProviderForSource(
  root: string,
  source: string,
  provider: string,
  opts: { overwrite: boolean },
): Promise<PersistedConnectorImport> {
  const adapter = connectorAdapterForImportProvider(provider);
  if (!adapter?.importConnector) {
    throw new GrowthError('unsupported_import_provider', `Provider "${provider}" is not supported.`, {
      supported: supportedConnectorImportProviders(),
    });
  }
  if (!adapter.sourceAliases.includes(source)) {
    throw new GrowthError('unsupported_import', `Provider "${provider}" cannot import connector "${source}".`, {
      supported_sources: adapter.sourceAliases,
    });
  }
  return importConnectorFromProvider(root, provider, opts);
}
