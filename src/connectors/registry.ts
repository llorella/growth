import type { ConnectorConfig } from '../lib/connectors.js';
import { localAdapter } from './local/adapter.js';
import { postHogAdapter } from './posthog/adapter.js';
import { statsigAdapter } from './statsig/adapter.js';
import type { ConnectorAdapter } from './types.js';

const adapters = new Map<ConnectorConfig['kind'], ConnectorAdapter>([
  [postHogAdapter.kind, postHogAdapter],
  [statsigAdapter.kind, statsigAdapter],
  [localAdapter.kind, localAdapter],
]);

export function connectorAdapterFor(connector: ConnectorConfig): ConnectorAdapter | undefined {
  return adapters.get(connector.kind);
}

export function supportedConnectorAdapterKinds(): ConnectorConfig['kind'][] {
  return Array.from(adapters.keys());
}

export function connectorAdapterForSource(
  source: string,
): { adapter: ConnectorAdapter; source: string } | undefined {
  const adapter = Array.from(adapters.values()).find((candidate) => candidate.sourceAliases.includes(source));
  return adapter ? { adapter, source: adapter.defaultSource } : undefined;
}

export function supportedConnectorSources(): string[] {
  return Array.from(new Set(Array.from(adapters.values()).flatMap((adapter) => adapter.sourceAliases)));
}

export function connectorAdapterForImportProvider(provider: string): ConnectorAdapter | undefined {
  return Array.from(adapters.values()).find((adapter) => adapter.importProviders.includes(provider));
}

export function supportedConnectorImportProviders(): string[] {
  return Array.from(new Set(Array.from(adapters.values()).flatMap((adapter) => adapter.importProviders)));
}
