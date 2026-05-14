import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  requiredConnectorEvents,
} from '../dist/lib/connector-catalog.js';
import { localAdapter } from '../dist/connectors/local/adapter.js';
import { defaultLocalConnector } from '../dist/connectors/local/config.js';
import { postHogAdapter } from '../dist/connectors/posthog/adapter.js';
import {
  defaultPostHogConnector,
  defaultPostHogMappings,
} from '../dist/connectors/posthog/config.js';
import { statsigAdapter } from '../dist/connectors/statsig/adapter.js';

test('PostHog adapter owns auth defaults and synthetic mapping paths', () => {
  const mappings = defaultPostHogMappings();
  const connector = defaultPostHogConnector('CUSTOM_POSTHOG_PROJECT', {
    apiKeyEnv: 'CUSTOM_POSTHOG_KEY',
    mappings,
  });

  assert.equal(connector.variant_id_path, 'properties.variant_id');
  assert.deepEqual(postHogAdapter.requiredEnv(connector), ['CUSTOM_POSTHOG_KEY', 'CUSTOM_POSTHOG_PROJECT']);
  assert.deepEqual(postHogAdapter.requiredScopes(connector), []);
  assert.equal(mappings.activation_completed.payload_paths.agent_generated, 'properties.agent_generated');
  assert.equal(mappings.activation_completed.payload_paths.agent_run_id, 'properties.agent_run_id');
  assert.equal(mappings.activation_completed.payload_paths.session_id, 'properties.session_id');

  const telemetryOnly = defaultPostHogConnector(undefined, {
    apiKeyEnv: 'POSTHOG_ANALYTICS_API_KEY',
  });
  assert.equal(telemetryOnly.posthog?.project_id, undefined);
  assert.deepEqual(postHogAdapter.requiredEnv(telemetryOnly), ['POSTHOG_ANALYTICS_API_KEY']);
});

test('local adapter owns connector taxonomy mappings', () => {
  const connector = defaultLocalConnector('tmp/events.jsonl');

  assert.deepEqual(localAdapter.requiredEnv(connector), []);
  assert.equal(connector.mappings.activation_completed.framework_event, 'activation_completed');
  assert.equal(connector.mappings.activation_completed.payload_paths.agent_generated, 'properties.agent_generated');
});

test('Statsig adapter pulls Console API events and normalizes them for mapping', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'growth-statsig-'));
  const originalFetch = globalThis.fetch;
  try {
    writeFileSync(
      path.join(root, '.env'),
      [
        'STATSIG_SERVER_SECRET=server-secret',
        'STATSIG_CONSOLE_API_KEY=console-secret',
        'STATSIG_PROJECT_ID=project-123',
        '',
      ].join('\n'),
    );
    const baseConnector = statsigAdapter.defaultConfig({ source: 'statsig' });
    const connector = {
      ...baseConnector,
      mappings: {
        activation_completed: baseConnector.mappings.activation_completed,
      },
    };
    assert.equal(connector.mappings.activation_completed.payload_paths.agent_generated, 'metadata.agent_generated');

    const inside = Date.parse('2026-05-14T00:00:01.000Z');
    const outside = Date.parse('2026-05-13T23:59:59.000Z');
    const calls = [];
    globalThis.fetch = async (input, init) => {
      calls.push({ input: String(input), headers: init?.headers });
      return new Response(
        JSON.stringify({
          message: 'Event values listed successfully.',
          data: [
            {
              timestamp: String(inside),
              name: 'activation_completed',
              source: 'statsig-node',
              value: '',
              userID: 'user_123',
              metadata: {
                experiment_id: 'statsig-provider-plan',
                variant_id: 'control',
                event_id: 'evt_123',
                agent_generated: true,
                agent_run_id: 'preflight_agent_1',
                session_id: 'session_123',
              },
            },
            {
              timestamp: String(outside),
              name: 'activation_completed',
              source: 'statsig-node',
              value: '',
              userID: 'old_user',
              metadata: {
                experiment_id: 'statsig-provider-plan',
                variant_id: 'control',
                event_id: 'evt_old',
              },
            },
          ],
          pagination: { nextPage: null },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    };

    const raw = await statsigAdapter.pullEvents(
      root,
      connector,
      {
        after: '2026-05-14T00:00:00.000Z',
        before: '2026-05-14T00:00:10.000Z',
      },
      10,
    );
    assert.equal(raw.length, 1);
    assert.match(calls[0].input, /\/console\/v1\/events\/activation_completed\?/);
    assert.equal(calls[0].headers['STATSIG-API-KEY'], 'console-secret');
    assert.equal(calls[0].headers['STATSIG-API-VERSION'], '20240601');

    const mapped = statsigAdapter.mapEvent(connector, raw[0]);
    assert.equal(mapped.drop_reason, undefined);
    assert.equal(mapped.event.experiment_id, 'statsig-provider-plan');
    assert.equal(mapped.event.event, 'activation_completed');
    assert.equal(mapped.event.user_id, 'user_123');
    assert.equal(mapped.event.variant_id, 'control');
    assert.equal(mapped.event.timestamp, '2026-05-14T00:00:01.000Z');
    assert.equal(mapped.event.idempotency_key, 'evt_123');
    assert.equal(mapped.event.payload.agent_generated, true);
    assert.equal(mapped.event.payload.agent_run_id, 'preflight_agent_1');
  } finally {
    globalThis.fetch = originalFetch;
    rmSync(root, { recursive: true, force: true });
  }
});

test('connector catalog derives active experiment event coverage', () => {
  const events = requiredConnectorEvents({
    id: 'connector-coverage',
    name: 'Connector coverage',
    hypothesis: 'More complete connector coverage prevents silent drops.',
    status: 'running',
    variants: [
      { id: 'control', name: 'Control', weight: 50 },
      { id: 'treatment', name: 'Treatment', weight: 50 },
    ],
    metrics: [
      {
        id: 'activation',
        name: 'Activation',
        role: 'primary',
        type: 'proportion',
        direction: 'higher_is_better',
        event: 'activation_completed',
        denominator_event: 'experiment_viewed',
      },
    ],
    targeting: { rules: [] },
    sample_size: {
      baseline_rate: 0.1,
      minimum_detectable_effect: 0.05,
      power: 0.8,
      alpha: 0.05,
    },
    schedule: { max_duration_days: 14 },
    instrumentation: {
      events: [
        {
          event: 'onboarding_started',
          required_properties: ['experiment_id', 'variant_id'],
        },
      ],
    },
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
  });

  assert.deepEqual(events.sort(), [
    'activation_completed',
    'experiment_viewed',
    'onboarding_started',
  ]);
});
