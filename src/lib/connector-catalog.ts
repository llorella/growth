import type { Experiment } from '../core/experiment/types.js';
import { SYNTHETIC_TRAFFIC_PAYLOAD_PATHS } from '../core/evidence/synthetic-traffic.js';
import { DEFAULT_EVENT_TAXONOMY } from './defaults.js';
import type { ConnectorConfig, ConnectorMapping } from '../connectors/types.js';

const CONNECTOR_KINDS = [
  'posthog',
  'native-app',
] as const;

export function isConnectorKind(kind: unknown): kind is ConnectorConfig['kind'] {
  return typeof kind === 'string' && CONNECTOR_KINDS.includes(kind as ConnectorConfig['kind']);
}

export function envProjectIds(projectId: string | number | undefined): string[] {
  return isEnvReference(projectId) ? [projectId] : [];
}

export function isEnvReference(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Z_][A-Z0-9_]*$/.test(value);
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
