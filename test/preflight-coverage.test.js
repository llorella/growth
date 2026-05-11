import test from 'node:test';
import assert from 'node:assert/strict';
import {
  preflightCoverage,
  requiredPreflightEvents,
  scenarioExpectedEvents,
} from '../dist/preflight/coverage.js';

test('required preflight coverage includes metric and instrumentation events', () => {
  const exp = coverageExperiment();

  assert.deepEqual(requiredPreflightEvents(exp), [
    'activation_completed',
    'experiment_viewed',
    'help_clicked',
    'onboarding_error',
    'onboarding_started',
    'workspace_created',
  ]);
});

test('inferred packet scenarios can narrow coverage while run coverage stays complete', () => {
  const exp = coverageExperiment();
  const coverage = preflightCoverage(exp);

  assert.deepEqual(coverage.required_events, [
    'activation_completed',
    'experiment_viewed',
    'help_clicked',
    'onboarding_error',
    'onboarding_started',
    'workspace_created',
  ]);
  assert.deepEqual(coverage.scenarios[0].expected_events, [
    'onboarding_started',
    'activation_completed',
  ]);
  assert.deepEqual(coverage.scenarios[1].expected_events, [
    'experiment_viewed',
    'onboarding_error',
  ]);
  assert.deepEqual(coverage.scenarios[2].expected_events, [
    'help_clicked',
    'workspace_created',
  ]);
});

test('configured packet scenarios keep their own expected event surface', () => {
  const exp = {
    ...coverageExperiment(),
    preflight: {
      scenarios: [
        {
          id: 'workspace_path',
          goal: 'Create a workspace.',
          expected_events: ['workspace_created'],
        },
      ],
    },
  };
  const scenario = preflightCoverage(exp).scenarios[0];

  assert.equal(scenario.id, 'workspace_path');
  assert.deepEqual(scenarioExpectedEvents(exp, scenario), ['workspace_created']);
  assert.deepEqual(requiredPreflightEvents(exp), [
    'activation_completed',
    'experiment_viewed',
    'help_clicked',
    'onboarding_error',
    'onboarding_started',
    'workspace_created',
  ]);
});

function coverageExperiment() {
  return {
    id: 'coverage-test',
    name: 'Coverage test',
    hypothesis:
      'We believe clearer onboarding will increase activation because users can reach value sooner.',
    status: 'draft',
    variants: [
      { id: 'control', name: 'Control', weight: 50 },
      { id: 'treatment', name: 'Treatment', weight: 50 },
    ],
    metrics: [
      {
        id: 'activation_rate',
        name: 'Activation rate',
        role: 'primary',
        type: 'proportion',
        direction: 'higher_is_better',
        event: 'activation_completed',
        denominator_event: 'onboarding_started',
      },
      {
        id: 'onboarding_error_rate',
        name: 'Onboarding error rate',
        role: 'guardrail',
        type: 'proportion',
        direction: 'lower_is_better',
        event: 'onboarding_error',
        denominator_event: 'experiment_viewed',
        guardrail_threshold: 0.1,
      },
    ],
    instrumentation: {
      events: [
        {
          event: 'workspace_created',
          required_properties: ['experiment_id', 'variant_id', 'user_id'],
        },
        {
          event: 'help_clicked',
          required_properties: ['experiment_id', 'variant_id', 'user_id'],
        },
      ],
    },
    targeting: { rules: [] },
    sample_size: {
      baseline_rate: 0.2,
      minimum_detectable_effect: 0.15,
      power: 0.8,
      alpha: 0.05,
    },
    schedule: { max_duration_days: 30, min_runtime_days: 7 },
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
  };
}
