import { createHash } from 'node:crypto';
import type { ConnectorConfig } from '../lib/connectors.js';
import type { ConnectorMapResult } from './types.js';

/**
 * Read a dot-path from an arbitrary JSON object. Supports `[n]` array indexing.
 */
export function readConnectorPath(obj: unknown, p: string): unknown {
  const parts = p.split('.').flatMap((seg) => {
    const m = seg.match(/^([^[]+)((?:\[\d+\])*)$/);
    if (!m) return [seg];
    const indices = (m[2].match(/\[\d+\]/g) ?? []).map((s) => parseInt(s.slice(1, -1), 10));
    return [m[1], ...indices.map((i) => `__idx${i}`)];
  });
  let cur: unknown = obj;
  for (const part of parts) {
    if (cur == null) return undefined;
    if (typeof part === 'string' && part.startsWith('__idx')) {
      const i = parseInt(part.slice(5), 10);
      if (!Array.isArray(cur)) return undefined;
      cur = cur[i];
    } else if (typeof cur === 'object') {
      cur = (cur as Record<string, unknown>)[part];
    } else {
      return undefined;
    }
  }
  return cur;
}

/**
 * Apply a connector to a raw source event, producing 0 or 1 framework event.
 * Returns null if the event should be dropped, with a reason for diagnostics.
 */
export function mapConnectorEvent(connector: ConnectorConfig, raw: unknown): ConnectorMapResult {
  const eventName = connector.event_name_path
    ? (readConnectorPath(raw, connector.event_name_path) as string | undefined)
    : undefined;
  if (!eventName) return { drop_reason: 'missing_event_name' };

  const rule = connector.mappings[eventName];
  if (!rule) return { drop_reason: `unmapped:${eventName}` };

  const explicitUserId = connector.user_id_path
    ? (readConnectorPath(raw, connector.user_id_path) as string | undefined)
    : undefined;
  const anonymousId = connector.anonymous_id_path
    ? (readConnectorPath(raw, connector.anonymous_id_path) as string | undefined)
    : undefined;
  const userId = explicitUserId ?? anonymousId;
  if (!userId) return { drop_reason: 'missing_user_id' };

  const experimentId = connector.experiment_id_path
    ? (readConnectorPath(raw, connector.experiment_id_path) as string | undefined)
    : undefined;
  if (!experimentId) return { drop_reason: 'missing_experiment_id' };

  const variantId = readVariantId(connector, raw);
  if (!variantId) return { drop_reason: 'missing_variant_id' };

  const idempotencyKey = connector.idempotency_key_path
    ? (readConnectorPath(raw, connector.idempotency_key_path) as string | undefined)
    : undefined;

  const timestamp = connector.timestamp_path
    ? (readConnectorPath(raw, connector.timestamp_path) as string | undefined)
    : (readConnectorPath(raw, 'timestamp') as string | undefined);

  const payload: Record<string, unknown> = {};
  if (rule.payload_paths) {
    for (const [k, p] of Object.entries(rule.payload_paths)) {
      const v = readConnectorPath(raw, p);
      if (v !== undefined) payload[k] = v;
    }
  }
  if (rule.payload_static) Object.assign(payload, rule.payload_static);

  return {
    event: {
      experiment_id: experimentId,
      user_id: userId,
      anonymous_id: anonymousId,
      variant_id: variantId,
      event: rule.framework_event ?? eventName,
      timestamp: timestamp ?? new Date().toISOString(),
      source: connector.source,
      payload: Object.keys(payload).length ? payload : undefined,
      idempotency_key:
        idempotencyKey ??
        stableEventKey(
          connector.source,
          experimentId,
          userId,
          variantId,
          rule.framework_event ?? eventName,
          timestamp,
          payload,
        ),
    },
  };
}

function readVariantId(connector: ConnectorConfig, raw: unknown): string | undefined {
  const configured = connector.variant_id_path
    ? (readConnectorPath(raw, connector.variant_id_path) as string | undefined)
    : undefined;
  if (configured) return configured;
  if (connector.variant_id_path === 'properties.variant_id') {
    return readConnectorPath(raw, 'properties.variant') as string | undefined;
  }
  return undefined;
}

function stableEventKey(
  source: string,
  experimentId: string,
  userId: string,
  variantId: string,
  event: string,
  timestamp: string | undefined,
  payload: Record<string, unknown>,
): string {
  const body = JSON.stringify({
    source,
    experiment_id: experimentId,
    user_id: userId,
    variant_id: variantId,
    event,
    timestamp,
    payload: sortObject(payload),
  });
  return createHash('sha256').update(body).digest('hex');
}

function sortObject(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortObject);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => [k, sortObject(v)]),
  );
}
