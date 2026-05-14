import { defaultTaxonomyMappings } from '../../lib/connector-catalog.js';
import type { ConnectorConfig } from '../../lib/connectors.js';

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
