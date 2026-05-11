import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildPreflightAudit,
  PREFLIGHT_AUDIT_CHECKS,
} from '../dist/preflight/audit-policy.js';
import { syntheticTrafficPayload } from '../dist/domain/synthetic-traffic.js';

test('preflight audit policy passes provider-backed complete evidence', () => {
  const audit = buildPreflightAudit({
    run: auditRun(),
    experiment: auditExperiment(),
    reports: [report('control'), report('treatment')],
    events: [
      event('experiment_viewed', 'control', 'agent-1'),
      event('conversion_completed', 'control', 'agent-1'),
      event('experiment_viewed', 'treatment', 'agent-2'),
      event('conversion_completed', 'treatment', 'agent-2'),
    ],
    providerBacked: true,
  });

  assert.equal(audit.recommendation, 'provider_preflight_passed');
  assert.equal(check(audit, PREFLIGHT_AUDIT_CHECKS.requiredEvents).status, 'pass');
  assert.equal(check(audit, PREFLIGHT_AUDIT_CHECKS.syntheticLabels).status, 'pass');
});

test('preflight audit policy distinguishes local-only readiness', () => {
  const audit = buildPreflightAudit({
    run: auditRun(),
    experiment: auditExperiment(),
    reports: [report('control'), report('treatment')],
    events: [
      event('experiment_viewed', 'control', 'agent-1'),
      event('conversion_completed', 'control', 'agent-1'),
      event('experiment_viewed', 'treatment', 'agent-2'),
      event('conversion_completed', 'treatment', 'agent-2'),
    ],
    providerBacked: false,
  });

  assert.equal(audit.recommendation, 'ready_for_provider_preflight');
});

test('preflight audit policy attributes missing required events after local verification', () => {
  const audit = buildPreflightAudit({
    run: auditRun(),
    experiment: auditExperiment(),
    reports: [report('control'), report('treatment')],
    events: [
      event('experiment_viewed', 'control', 'agent-1'),
      event('experiment_viewed', 'treatment', 'agent-2'),
    ],
    latestLocalVerification: {
      id: 'instrumentation_1',
      file: '.growth/runs/instrumentation_1/verify.json',
      ok: true,
    },
    providerBacked: false,
  });

  const required = check(audit, PREFLIGHT_AUDIT_CHECKS.requiredEvents);
  assert.equal(audit.recommendation, 'extend_preflight_coverage');
  assert.equal(required.status, 'fail');
  assert.equal(required.evidence.attribution, 'synthetic_coverage_gap');
});

test('preflight audit policy fails untrustworthy event window timestamps', () => {
  const badEvent = event('experiment_viewed', 'control', 'agent-1');
  const audit = buildPreflightAudit({
    run: auditRun(),
    experiment: auditExperiment(),
    reports: [report('control'), report('treatment')],
    events: [
      event('experiment_viewed', 'control', 'agent-1'),
      event('conversion_completed', 'control', 'agent-1'),
      event('experiment_viewed', 'treatment', 'agent-2'),
      event('conversion_completed', 'treatment', 'agent-2'),
    ],
    eventWindowRejections: [{ item: badEvent, reason: 'invalid_timestamp' }],
    providerBacked: false,
  });

  const timestamps = check(audit, PREFLIGHT_AUDIT_CHECKS.eventWindowTimestamps);
  assert.equal(audit.recommendation, 'fix_app_instrumentation');
  assert.equal(timestamps.status, 'fail');
  assert.equal(timestamps.evidence.rejected[0].reason, 'invalid_timestamp');
});

test('preflight audit policy blocks unlabeled synthetic evidence', () => {
  const audit = buildPreflightAudit({
    run: auditRun(),
    experiment: auditExperiment(),
    reports: [report('control'), report('treatment')],
    events: [
      event('experiment_viewed', 'control', 'agent-1'),
      event('conversion_completed', 'control', 'agent-1'),
      {
        ...event('experiment_viewed', 'treatment', 'agent-2'),
        payload: { agent_generated: true },
      },
      event('conversion_completed', 'treatment', 'agent-2'),
    ],
    providerBacked: false,
  });

  assert.equal(audit.recommendation, 'do_not_launch');
  assert.equal(check(audit, PREFLIGHT_AUDIT_CHECKS.syntheticLabels).status, 'fail');
});

function check(audit, id) {
  const found = audit.checks.find((item) => item.id === id);
  assert.ok(found, `missing audit check ${id}`);
  return found;
}

function auditRun() {
  return {
    id: 'preflight_1',
    type: 'preflight',
    experiment_id: 'conversion-test',
    status: 'completed',
    created_at: '2026-01-01T00:00:00.000Z',
    completed_at: '2026-01-01T00:10:00.000Z',
    event_window: {
      after: '2026-01-01T00:00:00.000Z',
      before: '2026-01-01T00:10:00.000Z',
    },
    agents: [
      {
        agent_id: 'agent-1',
        browser: true,
        variant_id: 'control',
        url_file: '',
        prompt_file: '',
        report_schema_file: '',
        policy_file: '',
      },
      {
        agent_id: 'agent-2',
        browser: true,
        variant_id: 'treatment',
        url_file: '',
        prompt_file: '',
        report_schema_file: '',
        policy_file: '',
      },
    ],
    artifacts: {},
    warnings: [],
  };
}

function auditExperiment() {
  return {
    id: 'conversion-test',
    name: 'Conversion test',
    hypothesis:
      'We believe improving the primary call to action will increase conversion because users will see a clearer next step.',
    status: 'draft',
    variants: [
      { id: 'control', name: 'Control', weight: 50 },
      { id: 'treatment', name: 'Treatment', weight: 50 },
    ],
    metrics: [
      {
        id: 'conversion_rate',
        name: 'Conversion rate',
        role: 'primary',
        type: 'proportion',
        direction: 'higher_is_better',
        event: 'conversion_completed',
        denominator_event: 'experiment_viewed',
      },
    ],
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

function event(name, variant, agentRunId) {
  return {
    experiment_id: 'conversion-test',
    user_id: `user-${agentRunId}`,
    variant_id: variant,
    event: name,
    timestamp: '2026-01-01T00:01:00.000Z',
    payload: syntheticTrafficPayload(agentRunId),
  };
}

function report(variant) {
  return {
    file: `report-${variant}.json`,
    primary_goal_observed: true,
    stop_reason: 'completed',
    variant_observed: variant,
    primary_metric_events_observed: ['conversion_completed'],
    guardrail_observed: false,
    confusing_or_broken: [],
    blockers: [],
    internal_ui_visible: [],
    missing_expected_events: [],
    screenshot_or_trace_artifacts: [],
  };
}
