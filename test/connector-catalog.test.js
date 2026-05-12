import test from 'node:test';
import assert from 'node:assert/strict';
import {
  connectorRequiredEnv,
  connectorRequiredScopes,
  defaultLocalConnector,
  defaultPostHogConnector,
  defaultPostHogMappings,
  requiredConnectorEvents,
} from '../dist/lib/connector-catalog.js';

test('connector catalog owns PostHog auth defaults and synthetic mapping paths', () => {
  const mappings = defaultPostHogMappings();
  const connector = defaultPostHogConnector('CUSTOM_POSTHOG_PROJECT', {
    apiKeyEnv: 'CUSTOM_POSTHOG_KEY',
    mappings,
  });

  assert.equal(connector.variant_id_path, 'properties.variant_id');
  assert.deepEqual(connectorRequiredEnv(connector), ['CUSTOM_POSTHOG_KEY', 'CUSTOM_POSTHOG_PROJECT']);
  assert.deepEqual(connectorRequiredScopes(connector.kind), []);
  assert.equal(mappings.activation_completed.payload_paths.agent_generated, 'properties.agent_generated');
  assert.equal(mappings.activation_completed.payload_paths.agent_run_id, 'properties.agent_run_id');
  assert.equal(mappings.activation_completed.payload_paths.session_id, 'properties.session_id');
});

test('connector catalog owns local connector taxonomy mappings', () => {
  const connector = defaultLocalConnector('tmp/events.jsonl');

  assert.deepEqual(connectorRequiredEnv(connector), []);
  assert.equal(connector.mappings.activation_completed.framework_event, 'activation_completed');
  assert.equal(connector.mappings.activation_completed.payload_paths.agent_generated, 'properties.agent_generated');
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
