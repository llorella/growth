import test from 'node:test';
import assert from 'node:assert/strict';
import { buildAnalysis } from '../dist/domain/analysis-policy.js';
import { syntheticTrafficPayload } from '../dist/domain/synthetic-traffic.js';

test('analysis policy filters in-memory evidence by segment', () => {
  const experiment = analysisExperiment();
  const assignments = [
    assignment('real-control', 'control'),
    assignment('agent-treatment', 'treatment'),
  ];
  const events = [
    event('real-control', 'control', 'experiment_viewed'),
    event('real-control', 'control', 'conversion_completed'),
    event('agent-treatment', 'treatment', 'experiment_viewed', syntheticTrafficPayload('agent-run-1')),
  ];

  const realUsers = buildAnalysis({
    experiment,
    assignments,
    events,
    segment: 'real-users',
    now: new Date('2026-01-08T00:00:00.000Z'),
  });
  assert.equal(realUsers.total_users, 1);
  assert.deepEqual(realUsers.per_variant, { control: { users: 1 }, treatment: { users: 0 } });
  assert.equal(realUsers.runtime_days, 7);
  assert.equal(realUsers.generated_at, '2026-01-08T00:00:00.000Z');

  const synthetic = buildAnalysis({
    experiment,
    assignments,
    events,
    segment: 'agent-generated',
    now: new Date('2026-01-08T00:00:00.000Z'),
  });
  assert.equal(synthetic.total_users, 1);
  assert.equal(synthetic.per_variant.treatment.users, 1);
  assert.equal(synthetic.recommendation.action, 'synthetic_only_no_ship');
});

test('analysis policy refuses mixed real-user and synthetic ship decisions', () => {
  const experiment = analysisExperiment();
  const assignments = [
    assignment('real-control', 'control'),
    assignment('agent-treatment', 'treatment'),
  ];
  const events = [
    event('real-control', 'control', 'experiment_viewed'),
    event('real-control', 'control', 'conversion_completed'),
    event('agent-treatment', 'treatment', 'experiment_viewed', syntheticTrafficPayload('agent-run-1')),
    event('agent-treatment', 'treatment', 'conversion_completed', syntheticTrafficPayload('agent-run-1')),
  ];

  const result = buildAnalysis({
    experiment,
    assignments,
    events,
    segment: 'all',
    now: new Date('2026-01-08T00:00:00.000Z'),
  });

  assert.equal(result.total_users, 2);
  assert.equal(result.recommendation.action, 'keep_running');
  assert.match(result.recommendation.reasoning, /mixed real-user and agent-generated/);
});

function analysisExperiment() {
  return {
    id: 'analysis-test',
    name: 'Analysis test',
    hypothesis: 'A clearer page improves conversion.',
    status: 'running',
    variants: [
      { id: 'control', name: 'Control', weight: 50 },
      { id: 'treatment', name: 'Treatment', weight: 50 },
    ],
    metrics: [
      {
        id: 'conversion',
        name: 'Conversion',
        role: 'primary',
        type: 'proportion',
        direction: 'higher_is_better',
        event: 'conversion_completed',
        denominator_event: 'experiment_viewed',
      },
    ],
    targeting: { rules: [] },
    sample_size: {
      baseline_rate: 0.1,
      minimum_detectable_effect: 0.05,
      power: 0.8,
      alpha: 0.05,
      per_variant: 30,
    },
    schedule: {
      max_duration_days: 14,
      min_runtime_days: 7,
    },
    auto_stop: {
      on_significance: true,
      on_guardrail_breach: true,
      min_runtime_days: 7,
    },
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    started_at: '2026-01-01T00:00:00.000Z',
  };
}

function assignment(userId, variantId) {
  return {
    experiment_id: 'analysis-test',
    user_id: userId,
    variant_id: variantId,
    assigned_at: '2026-01-01T00:00:00.000Z',
  };
}

function event(userId, variantId, name, payload) {
  return {
    experiment_id: 'analysis-test',
    user_id: userId,
    variant_id: variantId,
    event: name,
    timestamp: '2026-01-01T12:00:00.000Z',
    payload,
  };
}
