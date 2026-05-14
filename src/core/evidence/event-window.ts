import type { ExperimentEvent } from '../experiment/types.js';

export interface EventWindow {
  after: string;
  before?: string;
}

export type EventWindowRejectionReason =
  | 'missing_timestamp'
  | 'invalid_timestamp'
  | 'before_window'
  | 'at_or_after_window'
  | 'invalid_window';

export interface EventWindowContainment {
  inside: boolean;
  reason?: EventWindowRejectionReason;
}

export interface EventWindowRejection<T> {
  item: T;
  reason: EventWindowRejectionReason;
}

export interface EventWindowFilterResult<T> {
  inside: T[];
  rejected: EventWindowRejection<T>[];
}

const ALL_LOCAL_EVIDENCE_AFTER = '1970-01-01T00:00:00.000Z';

export function openEventWindow(after = new Date().toISOString()): EventWindow {
  return { after };
}

export function allLocalEvidenceWindow(before?: string): EventWindow {
  return before ? { after: ALL_LOCAL_EVIDENCE_AFTER, before } : { after: ALL_LOCAL_EVIDENCE_AFTER };
}

export function closeEventWindow(
  window: EventWindow | undefined,
  fallbackAfter: string,
  before = new Date().toISOString(),
): EventWindow {
  return {
    after: window?.after ?? fallbackAfter,
    before,
  };
}

export function containsTimestamp(
  window: EventWindow,
  timestamp: string | undefined,
): EventWindowContainment {
  const parsedWindow = parseWindow(window);
  if (!parsedWindow) return { inside: false, reason: 'invalid_window' };
  if (!timestamp) return { inside: false, reason: 'missing_timestamp' };

  const eventTime = Date.parse(timestamp);
  if (!Number.isFinite(eventTime)) {
    return { inside: false, reason: 'invalid_timestamp' };
  }

  if (eventTime < parsedWindow.after) {
    return { inside: false, reason: 'before_window' };
  }
  if (parsedWindow.before !== undefined && eventTime >= parsedWindow.before) {
    return { inside: false, reason: 'at_or_after_window' };
  }
  return { inside: true };
}

export function filterByEventWindow<T extends { timestamp?: string }>(
  items: T[],
  window: EventWindow,
): EventWindowFilterResult<T> {
  const inside: T[] = [];
  const rejected: EventWindowRejection<T>[] = [];
  for (const item of items) {
    const result = containsTimestamp(window, item.timestamp);
    if (result.inside) {
      inside.push(item);
    } else {
      rejected.push({ item, reason: result.reason ?? 'invalid_window' });
    }
  }
  return { inside, rejected };
}

export function isUntrustworthyTimestamp(reason: EventWindowRejectionReason): boolean {
  return (
    reason === 'missing_timestamp' ||
    reason === 'invalid_timestamp' ||
    reason === 'invalid_window'
  );
}

export function eventTimestampEvidence(
  rejection: EventWindowRejection<ExperimentEvent>,
): Record<string, unknown> {
  return {
    reason: rejection.reason,
    event: rejection.item.event,
    user_id: rejection.item.user_id,
    variant_id: rejection.item.variant_id,
    timestamp: rejection.item.timestamp,
  };
}

function parseWindow(window: EventWindow): { after: number; before?: number } | null {
  const after = Date.parse(window.after);
  if (!Number.isFinite(after)) return null;
  if (window.before === undefined) return { after };
  const before = Date.parse(window.before);
  if (!Number.isFinite(before) || before < after) return null;
  return { after, before };
}
