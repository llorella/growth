import type { Experiment } from '../core/experiment/types.js';
import { requiredConnectorEvents } from '../lib/connector-catalog.js';
import type { ConnectorConfig } from '../lib/connectors.js';
import { GrowthError } from '../lib/envelope.js';
import { connectorAdapterFor } from './registry.js';

/**
 * Verify every event referenced by an active (non-stopped, non-completed)
 * experiment has a mapping somewhere across the loaded connector adapters.
 * Throws if any event is unmapped - pull would silently drop those events otherwise.
 */
export function assertConnectorCoverage(
  experiments: Experiment[],
  connectors: ConnectorConfig[],
): void {
  const required = new Set<string>();
  for (const exp of experiments) {
    if (exp.status === 'stopped' || exp.status === 'completed') continue;
    for (const event of requiredConnectorEvents(exp)) required.add(event);
  }
  const provided = new Set<string>();
  for (const connector of connectors) {
    const adapter = connectorAdapterFor(connector);
    for (const event of adapter?.mappedEvents(connector) ?? []) {
      provided.add(event);
    }
  }
  const missing: string[] = [];
  for (const event of required) {
    if (!provided.has(event)) missing.push(event);
  }
  if (missing.length > 0) {
    throw new GrowthError(
      'connector_coverage_gap',
      `${missing.length} event(s) referenced by active experiments have no connector mapping.`,
      { missing, hint: 'Add framework_event mappings in .growth/connectors/*.json.' },
    );
  }
}
