import test from 'node:test';
import assert from 'node:assert/strict';
import {
  closeEventWindow,
  containsTimestamp,
  filterByEventWindow,
  openEventWindow,
} from '../dist/domain/event-window.js';

test('event windows are half-open', () => {
  const window = {
    after: '2026-01-01T00:00:00.000Z',
    before: '2026-01-02T00:00:00.000Z',
  };

  assert.deepEqual(containsTimestamp(window, '2025-12-31T23:59:59.999Z'), {
    inside: false,
    reason: 'before_window',
  });
  assert.deepEqual(containsTimestamp(window, '2026-01-01T00:00:00.000Z'), {
    inside: true,
  });
  assert.deepEqual(containsTimestamp(window, '2026-01-01T23:59:59.999Z'), {
    inside: true,
  });
  assert.deepEqual(containsTimestamp(window, '2026-01-02T00:00:00.000Z'), {
    inside: false,
    reason: 'at_or_after_window',
  });
});

test('event windows reject missing and invalid timestamps', () => {
  const window = openEventWindow('2026-01-01T00:00:00.000Z');

  assert.deepEqual(containsTimestamp(window, undefined), {
    inside: false,
    reason: 'missing_timestamp',
  });
  assert.deepEqual(containsTimestamp(window, 'not-a-date'), {
    inside: false,
    reason: 'invalid_timestamp',
  });
});

test('event window filtering reports rejected events', () => {
  const window = closeEventWindow(
    openEventWindow('2026-01-01T00:00:00.000Z'),
    'ignored',
    '2026-01-02T00:00:00.000Z',
  );
  const result = filterByEventWindow(
    [
      { id: 'inside', timestamp: '2026-01-01T12:00:00.000Z' },
      { id: 'edge', timestamp: '2026-01-02T00:00:00.000Z' },
      { id: 'bad', timestamp: 'bad' },
    ],
    window,
  );

  assert.deepEqual(result.inside.map((item) => item.id), ['inside']);
  assert.deepEqual(
    result.rejected.map((rejection) => [rejection.item.id, rejection.reason]),
    [
      ['edge', 'at_or_after_window'],
      ['bad', 'invalid_timestamp'],
    ],
  );
});
