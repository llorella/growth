import type { Experiment } from '../domain/types.js';
import { SYNTHETIC_TRAFFIC_PAYLOAD_PATHS } from '../domain/synthetic-traffic.js';
import { DEFAULT_EVENT_TAXONOMY } from './defaults.js';
import type { ConnectorConfig, ConnectorMapping } from './connectors.js';

export const CONNECTOR_KINDS = [
  'posthog',
  'segment',
  'stripe',
  'native-app',
  'warehouse',
  'custom',
] as const;

export const POSTHOG_DEFAULT_HOST = 'https://us.posthog.com';
export const POSTHOG_DEFAULT_HOST_ENV = 'POSTHOG_ANALYTICS_HOST';
export const POSTHOG_DEFAULT_PROJECT_ID = 'POSTHOG_PROJECT_ID';
export const POSTHOG_DEFAULT_API_KEY_ENV = 'POSTHOG_ANALYTICS_API_KEY';
export const POSTHOG_REQUIRED_SCOPES: string[] = [];

export function isConnectorKind(kind: unknown): kind is ConnectorConfig['kind'] {
  return typeof kind === 'string' && CONNECTOR_KINDS.includes(kind as ConnectorConfig['kind']);
}

export function connectorRequiredScopes(kind: ConnectorConfig['kind'] | string | undefined): string[] {
  return kind === 'posthog' ? [...POSTHOG_REQUIRED_SCOPES] : [];
}

export function connectorApiKeyEnv(
  connector: Pick<ConnectorConfig, 'kind' | 'posthog'>,
): string | undefined {
  return connector.posthog?.api_key_env ?? (connector.kind === 'posthog' ? POSTHOG_DEFAULT_API_KEY_ENV : undefined);
}

export function connectorRequiredEnv(
  connector: Pick<ConnectorConfig, 'kind' | 'posthog'>,
): string[] {
  if (connector.kind !== 'posthog') return [];
  return postHogRequiredEnv(connectorApiKeyEnv(connector), connector.posthog?.project_id);
}

export function postHogRequiredEnv(
  apiKeyEnv: string | undefined,
  projectId: string | number | undefined,
): string[] {
  return [apiKeyEnv, ...envProjectIds(projectId)].filter((value): value is string => !!value);
}

export function envProjectIds(projectId: string | number | undefined): string[] {
  return isEnvReference(projectId) ? [projectId] : [];
}

export function isEnvReference(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Z_][A-Z0-9_]*$/.test(value);
}

export function defaultPostHogConnector(
  projectId?: string | number,
  opts: {
    host?: string;
    apiKeyEnv?: string;
    mappings?: ConnectorConfig['mappings'];
  } = {},
): ConnectorConfig {
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
      host: opts.host ?? POSTHOG_DEFAULT_HOST,
      api_key_env: opts.apiKeyEnv ?? POSTHOG_DEFAULT_API_KEY_ENV,
      ...(projectId !== undefined ? { project_id: projectId } : {}),
    },
    mappings: opts.mappings ?? {},
  };
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
    mappings: defaultLocalMappings(),
  };
}

export function defaultLocalMappings(): ConnectorConfig['mappings'] {
  return defaultTaxonomyMappings({ includeFrameworkEvent: true });
}

export function defaultPostHogMappings(): ConnectorConfig['mappings'] {
  return defaultTaxonomyMappings({ includeFrameworkEvent: false });
}

export function defaultTaxonomyMappings(opts: { includeFrameworkEvent: boolean }): ConnectorConfig['mappings'] {
  return Object.fromEntries(
    DEFAULT_EVENT_TAXONOMY.events.map((event) => {
      const mapping: ConnectorMapping = {
        payload_paths: syntheticTrafficConnectorPayloadPaths(),
      };
      if (opts.includeFrameworkEvent) mapping.framework_event = event.event;
      return [event.event, mapping];
    }),
  );
}

export function syntheticTrafficConnectorPayloadPaths(): Record<string, string> {
  return {
    ...SYNTHETIC_TRAFFIC_PAYLOAD_PATHS,
    session_id: 'properties.session_id',
  };
}

export function requiredConnectorEvents(exp: Experiment): string[] {
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
