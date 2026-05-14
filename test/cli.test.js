import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const repoRoot = path.resolve(import.meta.dirname, '..');
const cli = path.join(repoRoot, 'dist', 'index.js');

function tempRoot() {
  return mkdtempSync(path.join(tmpdir(), 'growth-test-'));
}

function cleanup(root) {
  rmSync(root, { recursive: true, force: true });
}

function run(root, args, options = {}) {
  const result = spawnSync(process.execPath, [cli, '--root', root, ...args], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: { ...process.env, ...(options.env ?? {}) },
  });
  const expectedStatus = options.status ?? 0;
  assert.equal(
    result.status,
    expectedStatus,
    `expected exit ${expectedStatus}, got ${result.status}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
  );
  if (!result.stdout.trim()) return null;
  return JSON.parse(result.stdout);
}

test('status before init does not create .growth', () => {
  const root = tempRoot();
  try {
    const status = run(root, ['status', '--json']);
    assert.equal(status.ok, true);
    assert.equal(status.data.initialized, false);
    assert.equal(existsSync(path.join(root, '.growth')), false);
  } finally {
    cleanup(root);
  }
});

test('empty project guidance is schema-first rather than template-specific', () => {
  const root = tempRoot();
  try {
    const init = run(root, ['init', '--json']);
    assert.deepEqual(init.next_steps.includes('growth schema experiment --json'), true);
    assert.equal(init.next_steps.some((step) => step.includes('conversion-test') || step.includes('onboarding-flow')), false);

    const status = run(root, ['status', '--json']);
    assert.equal(status._next.command, 'growth schema experiment --json');

    const context = run(root, ['llm-context', '--json']);
    assert.equal(context._next.command, 'growth schema experiment --json');
    assert.equal(context.data.commands.some((command) => command.includes('conversion-test')), false);
    assert.equal(context.data.commands.some((command) => command.includes('--source posthog')), false);
    assert.equal(context.data.commands.some((command) => command.includes('--source <source>')), true);
  } finally {
    cleanup(root);
  }
});

test('project profile commands persist explicit control-plane facts', () => {
  const root = tempRoot();
  try {
    run(root, ['init', '--framework', 'unknown', '--json']);

    const initial = run(root, ['project', 'show', '--json']);
    assert.equal(initial.data.profile.framework.id, 'unknown');
    assert.equal(initial.data.unknowns.some((unknown) => unknown.fact === 'framework'), true);
    assert.equal(initial.data.unknowns.some((unknown) => unknown.fact === 'app_urls.default'), true);

    const configured = run(root, [
      'project',
      'configure',
      '--framework',
      'react-vite',
      '--app-url',
      'http://localhost:4444',
      '--json',
    ]);
    assert.equal(configured.data.profile.framework.id, 'react-vite');
    assert.equal(configured.data.profile.framework.source, 'user');
    assert.equal(configured.data.profile.app_urls.default, 'http://localhost:4444');

    const route = run(root, ['project', 'route', 'add', 'onboarding', '--path', 'onboarding', '--json']);
    assert.deepEqual(route.data.route, {
      id: 'onboarding',
      path: '/onboarding',
      source: 'user',
    });

    const authContext = run(root, [
      'project',
      'auth-context',
      'add',
      'authenticated-user',
      '--requires-session',
      '--json',
    ]);
    assert.deepEqual(authContext.data.auth_context, {
      id: 'authenticated-user',
      requires_session: true,
      source: 'user',
    });

    const status = run(root, ['status', '--json']);
    assert.equal(status.data.framework, 'react-vite');
    assert.equal(status.data.project_profile.app_urls.default, 'http://localhost:4444');

    const context = run(root, ['llm-context', '--json']);
    assert.equal(context.data.project_profile.framework.id, 'react-vite');
    assert.equal(context.data.local_servers.app_url, 'http://localhost:4444');
    assert.equal(context.data.commands.includes('growth project show --json'), true);
  } finally {
    cleanup(root);
  }
});

test('project framework options canonicalize aliases and reject unsupported ids', () => {
  const root = tempRoot();
  try {
    const init = run(root, ['init', '--framework', 'nextjs', '--json']);
    assert.equal(init.data.framework, 'nextjs-app-router');

    let profile = run(root, ['project', 'show', '--json']);
    assert.equal(profile.data.profile.framework.id, 'nextjs-app-router');

    const configured = run(root, ['project', 'configure', '--framework', 'vite', '--json']);
    assert.equal(configured.data.profile.framework.id, 'react-vite');

    const invalid = run(root, ['project', 'configure', '--framework', 'next-ish', '--json'], { status: 1 });
    assert.equal(invalid.ok, false);
    assert.equal(invalid.error.code, 'unsupported_framework');
    assert.deepEqual(invalid.error.details.supported.includes('nextjs-app-router'), true);

    profile = run(root, ['project', 'show', '--json']);
    assert.equal(profile.data.profile.framework.id, 'react-vite');
  } finally {
    cleanup(root);
  }
});

test('init does not infer framework from package metadata', () => {
  const root = tempRoot();
  try {
    writeFileSync(
      path.join(root, 'package.json'),
      JSON.stringify({ dependencies: { next: '^15.0.0', react: '^19.0.0' } }) + '\n',
    );
    mkdirSync(path.join(root, 'app'), { recursive: true });

    const init = run(root, ['init', '--json']);
    assert.equal(init.data.framework, 'unknown');
    assert.equal(init.data.framework_hint.detected, 'unknown');

    const profile = run(root, ['project', 'show', '--json']);
    assert.equal(profile.data.profile.framework.id, 'unknown');
    assert.equal(profile.data.unknowns.some((unknown) => unknown.fact === 'framework'), true);
  } finally {
    cleanup(root);
  }
});

test('preflight runtime uses stored project profile instead of framework source detection', () => {
  const root = tempRoot();
  try {
    run(root, ['init', '--framework', 'nextjs-app-router', '--json']);
    writeFileSync(
      path.join(root, 'package.json'),
      JSON.stringify({ dependencies: { react: '^19.0.0', vite: '^8.0.0' } }) + '\n',
    );
    run(root, ['experiment', 'create', 'my-test', '--template', 'conversion-test', '--json']);

    const profileBacked = run(root, ['preflight', 'prepare', 'my-test', '--agents', '1', '--json']);
    assert.equal(profileBacked.data.framework_hint.detected, 'nextjs-app-router');
    assert.equal(profileBacked.data.app_url, 'http://localhost:3000');

    run(root, ['project', 'configure', '--framework', 'react-vite', '--json']);
    const reconfigured = run(root, ['preflight', 'prepare', 'my-test', '--agents', '1', '--json']);
    assert.equal(reconfigured.data.framework_hint.detected, 'react-vite');
    assert.equal(reconfigured.data.app_url, 'http://localhost:5173');
  } finally {
    cleanup(root);
  }
});

test('core experiment flow labels simulated traffic as synthetic-only', () => {
  const root = tempRoot();
  try {
    assert.equal(run(root, ['init', '--json']).ok, true);
    assert.equal(existsSync(path.join(root, '.growth', 'templates', 'conversion-test.json')), false);
    const templates = run(root, ['template', 'list', '--json']);
    assert.deepEqual(templates.data.templates.includes('conversion-test'), true);
    assert.equal(templates.data.sources['conversion-test'], 'built-in');
    const shownTemplate = run(root, ['template', 'show', 'conversion-test', '--json']);
    assert.equal(shownTemplate.data.source, 'built-in');

    const created = run(root, [
      'experiment',
      'create',
      'my-test',
      '--template',
      'conversion-test',
      '--json',
    ]);
    assert.equal(created.data.experiment.id, 'my-test');

    const preflight = run(root, [
      'preflight',
      'prepare',
      'my-test',
      '--agents',
      '1',
      '--browser',
      '--json',
    ]);
    assert.equal(preflight.data.run.agents.length, 1);

    run(root, ['simulate', 'my-test', '--days', '7', '--daily', '60', '--lift', '0.3', '--json']);
    const defaultAnalysis = run(root, ['analyze', 'my-test', '--json']);
    assert.equal(defaultAnalysis.data.segment, 'real-users');
    assert.notEqual(defaultAnalysis.data.recommendation.action, 'ship_treatment');
    const analysis = run(root, ['analyze', 'my-test', '--segment', 'agent-generated', '--json']);
    assert.equal(analysis.data.recommendation.action, 'synthetic_only_no_ship');
  } finally {
    cleanup(root);
  }
});

test('all-segment analysis refuses mixed synthetic and real traffic ship decisions', () => {
  const root = tempRoot();
  try {
    run(root, ['init', '--framework', 'nextjs-app-router', '--json']);
    run(root, ['experiment', 'create', 'my-test', '--template', 'conversion-test', '--json']);
    run(root, ['connector', 'add', 'local', '--events-file', 'tmp/events.jsonl', '--json']);
    mkdirSync(path.join(root, 'tmp'), { recursive: true });
    writeFileSync(
      path.join(root, 'tmp', 'events.jsonl'),
      [
        eventLine('my-test', 'real-view', 'experiment_viewed', '2026-01-01T00:00:00.000Z', {
          agentGenerated: false,
          agentRunId: null,
          userId: 'real-user-1',
        }),
        eventLine('my-test', 'synthetic-view', 'experiment_viewed', '2026-01-01T00:01:00.000Z', {
          agentGenerated: true,
          agentRunId: 'synthetic-run-1',
          userId: 'synthetic-user-1',
        }),
      ].join('\n') + '\n',
    );
    run(root, [
      'pull',
      'my-test',
      '--source',
      'local',
      '--after',
      '2026-01-01T00:00:00.000Z',
      '--before',
      '2026-01-02T00:00:00.000Z',
      '--json',
    ]);
    const analysis = run(root, ['analyze', 'my-test', '--segment', 'all', '--json']);
    assert.equal(analysis.data.segment, 'all');
    assert.equal(analysis.data.recommendation.action, 'keep_running');
    assert.match(analysis.data.recommendation.reasoning, /mixed real-user and agent-generated/);
  } finally {
    cleanup(root);
  }
});

test('analysis uses configured sample size before recommending ship', () => {
  const root = tempRoot();
  try {
    run(root, ['init', '--framework', 'nextjs-app-router', '--json']);
    const spec = {
      id: 'sample-size-test',
      name: 'Sample size test',
      hypothesis:
        'We believe a stronger call to action will increase conversion because users understand the next step.',
      status: 'running',
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
      sample_size: {
        baseline_rate: 0.2,
        minimum_detectable_effect: 0.2,
        power: 0.8,
        alpha: 0.05,
        per_variant: 500,
      },
      schedule: { max_duration_days: 30, min_runtime_days: 7 },
      auto_stop: { on_significance: true, on_guardrail_breach: true, min_runtime_days: 7 },
      targeting: { rules: [] },
      created_at: '2026-01-01T00:00:00.000Z',
      updated_at: '2026-01-01T00:00:00.000Z',
      started_at: '2026-01-01T00:00:00.000Z',
    };
    const specFile = path.join(root, 'spec.json');
    writeFileSync(specFile, JSON.stringify(spec) + '\n');
    run(root, ['experiment', 'create', 'sample-size-test', '--from-file', specFile, '--json']);
    run(root, ['connector', 'add', 'local', '--events-file', 'tmp/events.jsonl', '--json']);
    mkdirSync(path.join(root, 'tmp'), { recursive: true });
    const lines = [];
    for (let i = 0; i < 40; i++) {
      const ts = new Date(Date.parse('2026-01-02T00:00:00.000Z') + i * 1000).toISOString();
      lines.push(
        eventLine('sample-size-test', `control-view-${i}`, 'experiment_viewed', ts, {
          agentGenerated: false,
          agentRunId: null,
          userId: `control-user-${i}`,
          variant: 'control',
        }),
      );
      lines.push(
        eventLine('sample-size-test', `treatment-view-${i}`, 'experiment_viewed', ts, {
          agentGenerated: false,
          agentRunId: null,
          userId: `treatment-user-${i}`,
          variant: 'treatment',
        }),
      );
      lines.push(
        eventLine('sample-size-test', `treatment-convert-${i}`, 'conversion_completed', ts, {
          agentGenerated: false,
          agentRunId: null,
          userId: `treatment-user-${i}`,
          variant: 'treatment',
        }),
      );
    }
    writeFileSync(path.join(root, 'tmp', 'events.jsonl'), lines.join('\n') + '\n');
    run(root, [
      'pull',
      'sample-size-test',
      '--source',
      'local',
      '--after',
      '2026-01-01T00:00:00.000Z',
      '--before',
      '2026-01-03T00:00:00.000Z',
      '--json',
    ]);
    const analysis = run(root, ['analyze', 'sample-size-test', '--json']);
    assert.equal(analysis.data.recommendation.action, 'keep_running');
    assert.match(analysis.data.recommendation.reasoning, /Need at least 500 users per variant/);
  } finally {
    cleanup(root);
  }
});

test('instrumentation plan uses custom events and root Next.js layout', () => {
  const root = tempRoot();
  try {
    writeFileSync(
      path.join(root, 'package.json'),
      JSON.stringify({ dependencies: { next: '^15.0.0', react: '^19.0.0' } }) + '\n',
    );
    mkdirSync(path.join(root, 'app'), { recursive: true });
    mkdirSync(path.join(root, 'app', 'utils'), { recursive: true });
    mkdirSync(path.join(root, 'hooks'), { recursive: true });

    run(root, ['init', '--framework', 'nextjs-app-router', '--json']);
    assert.equal(existsSync(path.join(root, '.agents', 'skills', 'growth', 'references', 'nextjs-app-router.md')), true);
    assert.equal(existsSync(path.join(root, '.agents', 'skills', 'growth', 'references', 'spa-navigation.md')), true);
    const skillReference = readFileSync(
      path.join(root, '.agents', 'skills', 'growth', 'references', 'nextjs-app-router.md'),
      'utf8',
    );
    const pullWorkflow = readFileSync(
      path.join(root, '.agents', 'skills', 'growth', 'workflows', 'pull-and-analyze.md'),
      'utf8',
    );
    assert.equal(skillReference.includes('PostHog-style'), false);
    assert.equal(skillReference.includes('connector_event_shapes'), true);
    assert.equal(pullWorkflow.includes('connector auth check posthog'), false);
    assert.equal(pullWorkflow.includes('Follow the returned `_next.command`'), true);
    const spec = {
      id: 'placeholder',
      name: 'Onboarding workspace test',
      hypothesis:
        'We believe making workspace creation clearer will increase onboarding completion because users will understand the first useful step.',
      status: 'draft',
      variants: [
        { id: 'control', name: 'Control', weight: 50 },
        { id: 'treatment', name: 'Treatment', weight: 50 },
      ],
      metrics: [
        {
          id: 'onboarding_completion_rate',
          name: 'Onboarding completion rate',
          role: 'primary',
          type: 'proportion',
          direction: 'higher_is_better',
          event: 'onboarding_completed',
          denominator_event: 'onboarding_started',
        },
      ],
      sample_size: {
        baseline_rate: 0.3,
        minimum_detectable_effect: 0.15,
        power: 0.8,
        alpha: 0.05,
      },
      schedule: { max_duration_days: 30, min_runtime_days: 7 },
      instrumentation: {
        assignment: {
          stable_by: 'anonymous_id',
          properties: ['experiment_id', 'variant_id', 'anonymous_id'],
        },
        events: [
          {
            event: 'workspace_created',
            required_properties: [
              'experiment_id',
              'variant_id',
              'anonymous_id',
              'workspace_name_present',
              'timestamp',
            ],
          },
        ],
      },
    };
    run(root, ['experiment', 'create', 'onboarding-flow', '--from-json', JSON.stringify(spec), '--json']);

    const plan = run(root, ['instrumentation', 'plan', 'onboarding-flow', '--json']);
    assert.equal(plan.data.framework, 'nextjs-app-router');
    assert.equal(plan.data.framework_hint.advisory_only, true);
    assert.deepEqual(plan.data.candidate_files.includes('app/utils/events.ts'), true);
    assert.deepEqual(plan.data.suggested_files.includes('app/utils/events.ts'), true);
    assert.deepEqual(plan.data.suggested_files.includes('app/api/events/route.ts'), true);
    assert.deepEqual(plan.data.suggested_files.some((file) => file.startsWith('src/')), false);
    assert.deepEqual(plan.data.preflight_query_params.map((param) => param.name), [
      'agent_generated',
      'agent_run_id',
      'experiment_id',
      'variant',
    ]);
    assert.equal(plan.data.variant_integrity.control_variant_id, 'control');
    assert.deepEqual(plan.data.variant_integrity.treatment_variant_ids, ['treatment']);
    assert.equal(
      plan.data.variant_integrity.requirements.some((requirement) => requirement.includes('Preserve control')),
      true,
    );
    assert.equal(
      plan.data.prompt_packet.rules.some((rule) => rule.includes('Preserve the control variant')),
      true,
    );
    assert.equal(plan.data.required_contract.assignment.stable_by, 'anonymous_id');
    assert.equal(
      plan.data.required_contract.agent_traffic.synthetic_context.storage.key,
      'growth.synthetic_context.onboarding-flow',
    );
    assert.equal(
      plan.data.required_contract.agent_traffic.synthetic_context.capture.when,
      'earliest_app_entrypoint_before_auth_redirects_or_client_navigation',
    );
    assert.equal(
      plan.data.known_pitfalls.some((pitfall) => pitfall.id === 'synthetic-context-persistence'),
      true,
    );
    assert.equal(
      plan.data.required_contract.agent_traffic.synthetic_context.event_properties.some(
        (property) => property.query_param === 'variant' && property.property === 'variant_id',
      ),
      true,
    );
    const workspaceEvent = plan.data.required_contract.events.find((event) => event.event === 'workspace_created');
    assert.ok(workspaceEvent);
    assert.deepEqual(workspaceEvent.required_properties.includes('workspace_name_present'), true);

    const sample = run(root, ['instrumentation', 'sample', 'onboarding-flow', '--json']);
    assert.ok(sample.data.samples.some((event) => event.event === 'workspace_created'));

    const actualEventsFile = path.join(root, 'actual-events.jsonl');
    writeFileSync(
      actualEventsFile,
      JSON.stringify({
        event: 'workspace_created',
        properties: {
          experiment_id: 'onboarding-flow',
          variant_id: 'control',
          anonymous_id: 'anon-1',
          timestamp: '2026-01-01T00:00:00.000Z',
        },
      }) + '\n',
    );
    const verify = run(root, [
      'instrumentation',
      'verify',
      'onboarding-flow',
      '--events-file',
      actualEventsFile,
      '--json',
    ]);
    assert.equal(verify.data.actual_event_check.ok, false);
    assert.equal(verify.data.taxonomy_unlisted_events.includes('workspace_created'), true);
    assert.equal(verify.warnings.some((warning) => warning.code === 'EVENT_NOT_IN_TAXONOMY'), false);
    assert.equal(
      verify.warnings.some((warning) => warning.code === 'ACTUAL_EVENT_PROPERTY_MISSING'),
      true,
    );
  } finally {
    cleanup(root);
  }
});

test('instrumentation plan flags anonymous assignment on authenticated targeting', () => {
  const root = tempRoot();
  try {
    run(root, ['init', '--framework', 'react-vite', '--json']);
    run(root, ['project', 'auth-context', 'add', 'authenticated-user', '--requires-session', '--json']);
    const spec = {
      id: 'auth-assignment',
      name: 'Authenticated assignment test',
      hypothesis:
        'We believe clearer authenticated onboarding will improve completion because signed in users get a more relevant first step.',
      status: 'draft',
      variants: [
        { id: 'control', name: 'Control', weight: 50 },
        { id: 'treatment', name: 'Treatment', weight: 50 },
      ],
      metrics: [
        {
          id: 'completion_rate',
          name: 'Completion rate',
          role: 'primary',
          type: 'proportion',
          direction: 'higher_is_better',
          event: 'onboarding_completed',
          denominator_event: 'onboarding_started',
        },
      ],
      targeting: {
        segments: ['authenticated renters without a completed profile'],
      },
      sample_size: {
        baseline_rate: 0.3,
        minimum_detectable_effect: 0.15,
        power: 0.8,
        alpha: 0.05,
      },
      schedule: { max_duration_days: 30, min_runtime_days: 7 },
      instrumentation: {
        assignment: {
          stable_by: 'anonymous_id',
          properties: ['experiment_id', 'variant_id', 'anonymous_id'],
        },
      },
    };
    run(root, ['experiment', 'create', 'auth-assignment', '--from-json', JSON.stringify(spec), '--json']);

    const plan = run(root, ['instrumentation', 'plan', 'auth-assignment', '--json']);
    assert.equal(plan.data.assignment_identity.status, 'review');
    assert.equal(plan.data.assignment_identity.recommended_stable_by, 'user_id');
    assert.equal(plan.warnings[0].code, 'AUTHENTICATED_ASSIGNMENT_STABLE_BY');
    assert.equal(
      plan.data.known_pitfalls.some((pitfall) => pitfall.id === 'auth-gated-synthetic-context'),
      true,
    );
    assert.equal(
      plan.data.prompt_packet.rules.some((rule) => rule.includes('before auth redirects')),
      true,
    );
    assert.equal(
      plan.data.prompt_packet.rules.some((rule) => rule.includes('Use user_id for stable assignment')),
      true,
    );

    const verify = run(root, ['instrumentation', 'verify', 'auth-assignment', '--json']);
    assert.equal(verify.data.assignment_identity.status, 'review');
    assert.equal(verify.warnings.some((warning) => warning.code === 'AUTHENTICATED_ASSIGNMENT_STABLE_BY'), true);
  } finally {
    cleanup(root);
  }
});

test('preflight attach-report validates report schema', () => {
  const root = tempRoot();
  try {
    run(root, ['init', '--json']);
    run(root, ['experiment', 'create', 'my-test', '--template', 'conversion-test', '--json']);
    const preflight = run(root, ['preflight', 'prepare', 'my-test', '--agents', '1', '--json']);
    const runId = preflight.data.run.id;

    const badReport = path.join(root, 'bad-report.json');
    writeFileSync(badReport, JSON.stringify({ primary_goal_observed: true }) + '\n');
    const bad = run(
      root,
      ['preflight', 'attach-report', runId, '--agent', '1', '--file', badReport, '--json'],
      { status: 1 },
    );
    assert.equal(bad.ok, false);
    assert.equal(bad.error.code, 'invalid_preflight_report');

    const goodReport = path.join(root, 'good-report.json');
    writeFileSync(
      goodReport,
      JSON.stringify({
        primary_goal_observed: true,
        stopped_at_url: 'http://localhost:3000/done',
        stop_reason: 'completed',
        path_taken: ['opened app', 'reached primary goal'],
        primary_metric_events_observed: ['conversion_completed'],
        guardrail_observed: false,
        confusing_or_broken: [],
        blockers: [],
        internal_ui_visible: [],
        missing_expected_events: [],
        screenshot_or_trace_artifacts: [],
      }) + '\n',
    );
    const good = run(root, [
      'preflight',
      'attach-report',
      runId,
      '--agent',
      '1',
      '--file',
      goodReport,
      '--json',
    ]);
    assert.equal(good.ok, true);
    assert.equal(good.data.report.endsWith('agent-1.report.json'), true);

    const audit = run(root, ['preflight', 'audit', runId, '--markdown', '--json']);
    assert.match(audit.data.markdown, /Reports attached: 1 \/ 1/);
    assert.match(audit.data.markdown, /Primary goal observed: 1 \/ 1/);
  } finally {
    cleanup(root);
  }
});

test('preflight prepare balances synthetic variant packets by default', () => {
  const root = tempRoot();
  try {
    run(root, ['init', '--json']);
    run(root, ['experiment', 'create', 'my-test', '--template', 'conversion-test', '--json']);
    const preflight = run(root, ['preflight', 'prepare', 'my-test', '--agents', '4', '--json']);
    const runId = preflight.data.run.id;
    const variants = [];
    for (let i = 1; i <= 4; i++) {
      const url = readFileSync(
        path.join(root, '.growth', 'runs', runId, 'agent-packets', `agent-${i}.url.txt`),
        'utf8',
      ).trim();
      variants.push(new URL(url).searchParams.get('variant'));
    }
    assert.deepEqual(variants, ['control', 'treatment', 'control', 'treatment']);
    assert.equal(preflight.warnings.some((warning) => warning.code === 'BALANCED_SYNTHETIC_VARIANTS'), true);
    assert.equal(preflight.warnings.some((warning) => warning.code === 'EVENT_WINDOW_START'), true);
    assert.match(preflight.next_steps.join('\n'), /Events before/);
  } finally {
    cleanup(root);
  }
});

test('preflight plan does not infer PostHog from source text without connector state', () => {
  const root = tempRoot();
  try {
    run(root, ['init', '--json']);
    run(root, ['project', 'auth-context', 'add', 'authenticated-user', '--requires-session', '--json']);
    writeFileSync(path.join(root, 'package.json'), JSON.stringify({ dependencies: { 'posthog-js': '^1.0.0' } }));
    const spec = genericSpec({
      id: 'onboarding-plan',
      event: 'activation_completed',
      denominatorEvent: 'experiment_viewed',
    });
    spec.targeting = { domains: ['/onboarding'], segments: ['authenticated renters'] };
    const specFile = path.join(root, 'spec.json');
    writeFileSync(specFile, JSON.stringify(spec));
    run(root, ['experiment', 'create', 'onboarding-plan', '--from-file', specFile, '--json']);

    const plan = run(root, ['preflight', 'plan', 'onboarding-plan', '--json']);
    assert.equal(plan.data.plan.evidence.preferred_evidence, 'unconfigured');
    assert.equal(plan.data.plan.evidence.why.includes('will not infer a provider'), true);
    assert.equal(plan.data.plan.evidence.readiness_ceiling, 'blocked');
    assert.equal(plan.data.plan.next_command, 'growth connector import stripe-projects --json');
    assert.equal(plan.data.plan.target_route, '/onboarding');
    assert.equal(plan.data.plan.target_route_source.kind, 'experiment_targeting');
    assert.equal(plan.data.plan.packet_app_url, 'http://localhost:3000/onboarding');
    assert.equal(plan.data.plan.browser_context.requires_authenticated_session, true);
    assert.equal(
      plan.data.plan.browser_context.requirements.some((requirement) => requirement.includes('authenticated test session')),
      true,
    );
    assert.equal(plan.warnings.some((warning) => warning.code === 'AUTHENTICATED_BROWSER_CONTEXT'), true);
  } finally {
    cleanup(root);
  }
});

test('preflight plan ignores host-only targeting domains when choosing route', () => {
  const root = tempRoot();
  try {
    run(root, ['init', '--json']);
    run(root, ['project', 'route', 'add', 'onboarding', '--path', '/onboarding', '--json']);
    const spec = genericSpec({
      id: 'host-only-targeting',
      event: 'activation_completed',
      denominatorEvent: 'experiment_viewed',
    });
    spec.targeting = { domains: ['localhost:3000'] };
    const specFile = path.join(root, 'spec.json');
    writeFileSync(specFile, JSON.stringify(spec));
    run(root, ['experiment', 'create', 'host-only-targeting', '--from-file', specFile, '--json']);

    const plan = run(root, ['preflight', 'plan', 'host-only-targeting', '--json']);
    assert.equal(plan.data.plan.target_route, '/onboarding');
    assert.equal(plan.data.plan.target_route_source.kind, 'project_profile');
    assert.equal(plan.data.plan.target_route_source.route_id, 'onboarding');
    assert.equal(plan.data.plan.packet_app_url, 'http://localhost:3000/onboarding');
  } finally {
    cleanup(root);
  }
});

test('preflight plan uses provider-backed connector when PostHog is ready', () => {
  const root = tempRoot();
  try {
    run(root, ['init', '--json']);
    const spec = genericSpec({
      id: 'provider-plan',
      event: 'activation_completed',
      denominatorEvent: 'experiment_viewed',
    });
    spec.targeting = { domains: ['/onboarding'] };
    const specFile = path.join(root, 'spec.json');
    writeFileSync(specFile, JSON.stringify(spec));
    run(root, ['experiment', 'create', 'provider-plan', '--from-file', specFile, '--json']);
    writeFileSync(
      path.join(root, '.env'),
      [
        'POSTHOG_ANALYTICS_API_KEY=phc_test',
        'POSTHOG_ANALYTICS_HOST=https://us.posthog.com',
        'POSTHOG_PROJECT_ID=123',
        '',
      ].join('\n'),
    );
    run(root, ['connector', 'import', 'stripe-projects', '--json']);

    const plan = run(root, ['preflight', 'plan', 'provider-plan', '--json']);
    assert.equal(plan.data.plan.evidence.preferred_evidence, 'posthog');
    assert.equal(plan.data.plan.evidence.readiness_ceiling, 'provider_preflight_passed');
    assert.match(plan.data.plan.next_command, /growth preflight run provider-plan/);
    assert.match(plan.data.plan.next_command, /--app-url http:\/\/localhost:3000\/onboarding/);
    assert.equal(plan.data.plan.readiness.ceiling, 'provider_preflight_passed');

    const preflight = run(root, ['preflight', 'run', 'provider-plan', '--agents', '1', '--browser', '--json']);
    assert.equal(preflight.data.status, 'prepared');
    assert.equal(preflight.data.preflight_plan.evidence.preferred_evidence, 'posthog');
    assert.match(preflight._next.command, /growth preflight complete /);
  } finally {
    cleanup(root);
  }
});

test('preflight plan treats Statsig as a provider-backed connector adapter', () => {
  const root = tempRoot();
  try {
    run(root, ['init', '--json']);
    const spec = genericSpec({
      id: 'statsig-provider-plan',
      event: 'activation_completed',
      denominatorEvent: 'experiment_viewed',
    });
    spec.targeting = { domains: ['/onboarding'] };
    const specFile = path.join(root, 'spec.json');
    writeFileSync(specFile, JSON.stringify(spec));
    run(root, ['experiment', 'create', 'statsig-provider-plan', '--from-file', specFile, '--json']);
    writeFileSync(path.join(root, '.env'), ['STATSIG_SERVER_SECRET=secret-test', ''].join('\n'));

    const added = run(root, ['connector', 'add', 'statsig', '--json']);
    assert.equal(added.data.connector.source, 'statsig');
    assert.equal(added.data.connector.kind, 'statsig');
    assert.equal(added.data.connector.statsig.server_key_env, 'STATSIG_SERVER_SECRET');
    assert.deepEqual(added.data.connector.statsig.project_id, 'STATSIG_PROJECT_ID');

    const auth = run(root, ['connector', 'auth', 'check', 'statsig', '--json']);
    assert.equal(auth.data.capabilities.telemetry_write.ready, true);
    assert.equal(auth.data.capabilities.provider_pull.ready, false);
    assert.deepEqual(auth.data.capabilities.provider_pull.missing, ['console_api_key', 'project_id']);

    const setup = run(root, ['connector', 'auth', 'setup', 'statsig', '--json']);
    assert.equal(setup.data.ready, false);
    assert.equal(setup.data.safe_commands.includes('growth env set --key STATSIG_CONSOLE_API_KEY --stdin'), true);
    assert.equal(setup.data.safe_commands.includes('growth env set --key STATSIG_PROJECT_ID --stdin'), true);

    const plan = run(root, ['preflight', 'plan', 'statsig-provider-plan', '--json']);
    assert.equal(plan.data.plan.evidence.preferred_evidence, 'statsig');
    assert.equal(plan.data.plan.evidence.readiness_ceiling, 'blocked');
    assert.equal(plan.data.plan.next_command, 'growth connector auth setup statsig --json');
    assert.equal(plan.data.plan.evidence.available_sources[0].evidence_source, 'statsig');
    assert.equal(plan.data.plan.evidence.available_sources[0].provider_backed, true);
    assert.equal(plan.data.plan.evidence.available_sources[0].telemetry_write_ready, true);
    assert.equal(plan.data.plan.evidence.available_sources[0].provider_pull_ready, false);
    assert.equal(plan.data.plan.evidence.blocked_sources[0].capability, 'provider_pull');
    assert.equal(plan.data.plan.evidence.blocked_sources[0].manual_input_required, true);
    assert.equal(plan.data.plan.evidence.blocked_sources[0].reason.includes('Statsig'), true);
  } finally {
    cleanup(root);
  }
});

test('variant implementation metadata is command-managed and appears in preflight plan', () => {
  const root = tempRoot();
  try {
    run(root, ['init', '--json']);
    const spec = genericSpec({
      id: 'variant-impl',
      event: 'activation_completed',
      denominatorEvent: 'experiment_viewed',
    });
    const specFile = path.join(root, 'spec.json');
    writeFileSync(specFile, JSON.stringify(spec));
    run(root, ['experiment', 'create', 'variant-impl', '--from-file', specFile, '--json']);

    const updated = run(root, [
      'experiment',
      'implementation',
      'set',
      'variant-impl',
      '--variant',
      'treatment',
      '--status',
      'ready',
      '--branch',
      'exp/onboarding-treatment',
      '--worktree',
      '../aptny-treatment',
      '--commit',
      'abc1234',
      '--pr-url',
      'https://example.com/pull/12',
      '--app-url',
      'https://treatment.aptny.localhost',
      '--json',
    ]);
    const treatment = updated.data.variant;
    assert.equal(treatment.id, 'treatment');
    assert.equal(treatment.implementation.status, 'ready');
    assert.equal(treatment.implementation.branch, 'exp/onboarding-treatment');

    const plan = run(root, ['preflight', 'plan', 'variant-impl', '--json']);
    const implementation = plan.data.plan.variant_implementations.find((item) => item.variant_id === 'treatment');
    assert.equal(implementation.status, 'ready');
    assert.equal(implementation.app_url, 'https://treatment.aptny.localhost');

    run(root, ['connector', 'add', 'local', '--events-file', 'tmp/events.jsonl', '--json']);
    const preflight = run(root, ['preflight', 'run', 'variant-impl', '--agents', '2', '--json']);
    const packetDir = path.join(root, '.growth', 'runs', preflight.data.run.id, 'agent-packets');
    const controlUrl = readFileSync(path.join(packetDir, 'agent-1.url.txt'), 'utf8').trim();
    const treatmentUrl = readFileSync(path.join(packetDir, 'agent-2.url.txt'), 'utf8').trim();
    assert.equal(new URL(controlUrl).origin, 'http://localhost:3000');
    assert.equal(new URL(treatmentUrl).origin, 'https://treatment.aptny.localhost');
    assert.equal(new URL(treatmentUrl).searchParams.get('variant'), 'treatment');
    assert.equal(preflight.warnings.some((warning) => warning.code === 'VARIANT_IMPLEMENTATION_URLS'), true);
  } finally {
    cleanup(root);
  }
});

test('experiment update accepts a JSON file source', () => {
  const root = tempRoot();
  try {
    run(root, ['init', '--json']);
    const spec = genericSpec({
      id: 'file-update',
      event: 'activation_completed',
      denominatorEvent: 'experiment_viewed',
    });
    const specFile = path.join(root, 'spec.json');
    writeFileSync(specFile, JSON.stringify(spec));
    run(root, ['experiment', 'create', 'file-update', '--from-file', specFile, '--json']);

    const nextSpec = {
      ...spec,
      id: 'ignored-id',
      name: 'Updated from file',
      notes: 'Updated without shelling inline JSON through process args.',
    };
    const updateFile = path.join(root, 'update.json');
    writeFileSync(updateFile, JSON.stringify(nextSpec));
    const updated = run(root, ['experiment', 'update', 'file-update', '--from-file', updateFile, '--json']);

    assert.equal(updated.data.experiment.id, 'file-update');
    assert.equal(updated.data.experiment.name, 'Updated from file');
    assert.equal(updated.next_steps.includes('growth validate --json'), true);
  } finally {
    cleanup(root);
  }
});

test('instrumentation verify does not mark preflight ready when provider pull is blocked', () => {
  const root = tempRoot();
  try {
    run(root, ['init', '--json']);
    const spec = genericSpec({
      id: 'blocked-provider',
      event: 'activation_completed',
      denominatorEvent: 'experiment_viewed',
    });
    const specFile = path.join(root, 'spec.json');
    writeFileSync(specFile, JSON.stringify(spec));
    run(root, ['experiment', 'create', 'blocked-provider', '--from-file', specFile, '--json']);
    writeFileSync(
      path.join(root, '.env'),
      [
        'POSTHOG_ANALYTICS_API_KEY=phc_test',
        'POSTHOG_ANALYTICS_HOST=https://us.posthog.com',
        '',
      ].join('\n'),
    );
    run(root, ['connector', 'import', 'stripe-projects', '--json']);

    const verify = run(root, ['instrumentation', 'verify', 'blocked-provider', '--json']);
    assert.equal(verify.data.ok, true);
    assert.equal(verify.data.ready_for_preflight, false);
    assert.equal(verify.data.ready_for_preflight_basis, 'blocked');
    assert.equal(verify.data.static_ready_for_preflight, false);
    assert.equal(verify.data.emitted_event_ready_for_preflight, false);
    assert.equal(verify.data.preflight_plan.readiness_ceiling, 'blocked');
    assert.equal(verify.warnings.some((warning) => warning.code === 'PREFLIGHT_BLOCKED'), true);
    assert.equal(verify._next.command, 'growth preflight plan blocked-provider --json');

    const plan = run(root, ['preflight', 'plan', 'blocked-provider', '--json']);
    assert.equal(plan.data.plan.next_command, 'growth connector auth setup posthog --json');
    assert.equal(plan.data.plan.evidence.available_sources[0].telemetry_write_ready, true);
    assert.equal(plan.data.plan.evidence.available_sources[0].provider_pull_ready, false);
    assert.equal(plan.data.plan.evidence.blocked_sources[0].capability, 'provider_pull');
    assert.equal(
      plan.data.plan.evidence.blocked_sources[0].reason.includes('app telemetry is configured'),
      true,
    );
    assert.equal(plan.data.plan.evidence.blocked_sources[0].manual_input_required, true);
    assert.equal(plan._next.command, 'growth connector auth setup posthog --json');

    const runsDir = path.join(root, '.growth', 'runs');
    const runsBefore = existsSync(runsDir) ? readdirSync(runsDir).sort() : [];
    const blockedRun = run(root, ['preflight', 'run', 'blocked-provider', '--json']);
    assert.equal(blockedRun.data.status, 'blocked');
    assert.equal(blockedRun.data.run, null);
    assert.equal(blockedRun._next.command, 'growth connector auth setup posthog --json');
    const runsAfter = existsSync(runsDir) ? readdirSync(runsDir).sort() : [];
    assert.deepEqual(runsAfter, runsBefore);
  } finally {
    cleanup(root);
  }
});

test('instrumentation verify distinguishes static readiness from emitted evidence', () => {
  const root = tempRoot();
  try {
    run(root, ['init', '--json']);
    const spec = genericSpec({
      id: 'static-only',
      event: 'activation_completed',
      denominatorEvent: 'experiment_viewed',
    });
    const specFile = path.join(root, 'spec.json');
    writeFileSync(specFile, JSON.stringify(spec));
    run(root, ['experiment', 'create', 'static-only', '--from-file', specFile, '--json']);
    run(root, ['connector', 'add', 'local', '--json']);

    const verify = run(root, ['instrumentation', 'verify', 'static-only', '--json']);
    assert.equal(verify.data.ok, true);
    assert.equal(verify.data.ready_for_preflight, true);
    assert.equal(verify.data.ready_for_preflight_basis, 'static_contract');
    assert.equal(verify.data.static_ready_for_preflight, true);
    assert.equal(verify.data.emitted_event_ready_for_preflight, false);
    assert.equal(verify.data.actual_events_verified, false);
    assert.equal(
      verify.warnings.some((warning) => warning.code === 'STATIC_ONLY_PREFLIGHT_READINESS'),
      true,
    );
  } finally {
    cleanup(root);
  }
});

test('preflight prepare uses project profile route and keeps provider evidence as the next step', () => {
  const root = tempRoot();
  try {
    run(root, ['init', '--json']);
    run(root, ['project', 'route', 'add', 'onboarding', '--path', '/onboarding', '--json']);
    run(root, ['project', 'auth-context', 'add', 'authenticated-user', '--requires-session', '--json']);
    const spec = genericSpec({
      id: 'scenario-route',
      event: 'activation_completed',
      denominatorEvent: 'experiment_viewed',
      preflight: {
        scenarios: [
          {
            id: 'onboarding_path',
            goal: 'Start from /onboarding and complete the activation path.',
            expected_events: ['experiment_viewed', 'activation_completed'],
          },
        ],
      },
    });
    spec.targeting = { domains: ['app'], segments: ['authenticated renters'] };
    const specFile = path.join(root, 'spec.json');
    writeFileSync(specFile, JSON.stringify(spec));
    run(root, ['experiment', 'create', 'scenario-route', '--from-file', specFile, '--json']);
    writeFileSync(
      path.join(root, '.env'),
      [
        'POSTHOG_ANALYTICS_API_KEY=phc_test',
        'POSTHOG_ANALYTICS_HOST=https://us.posthog.com',
        'POSTHOG_PROJECT_ID=123',
        '',
      ].join('\n'),
    );
    run(root, ['connector', 'import', 'stripe-projects', '--json']);

    const plan = run(root, ['preflight', 'plan', 'scenario-route', '--json']);
    assert.equal(plan.data.plan.target_route, '/onboarding');
    assert.equal(plan.data.plan.target_route_source.kind, 'project_profile');
    assert.equal(plan.data.plan.target_route_source.route_id, 'onboarding');
    assert.equal(plan.data.plan.packet_app_url, 'http://localhost:3000/onboarding');
    assert.equal(plan.data.plan.browser_context.requires_authenticated_session, true);

    const preflight = run(root, [
      'preflight',
      'prepare',
      'scenario-route',
      '--agents',
      '1',
      '--browser',
      '--app-url',
      'http://localhost:3000/',
      '--json',
    ]);
    assert.equal(preflight.data.packet_app_url, 'http://localhost:3000/onboarding');
    assert.equal(preflight.warnings.some((warning) => warning.code === 'TARGET_ROUTE_APPLIED'), true);
    assert.equal(preflight.warnings.some((warning) => warning.code === 'AUTHENTICATED_BROWSER_CONTEXT'), true);
    assert.match(preflight._next.command, /growth preflight complete /);
    assert.doesNotMatch(preflight._next.command, /complete-local/);
    const packetUrl = readFileSync(
      path.join(root, '.growth', 'runs', preflight.data.run.id, 'agent-packets', 'agent-1.url.txt'),
      'utf8',
    ).trim();
    assert.equal(new URL(packetUrl).pathname, '/onboarding');
    const policy = JSON.parse(
      readFileSync(
        path.join(root, '.growth', 'runs', preflight.data.run.id, 'agent-packets', 'agent-1.policy.json'),
        'utf8',
      ),
    );
    assert.equal(policy.browser_context.requires_authenticated_session, true);
    assert.equal(policy.browser_context.blocker_report_fields.includes('auth_or_payment_blockers'), true);

    const completed = run(root, ['preflight', 'complete', preflight.data.run.id, '--json']);
    assert.equal(completed._next.command, `growth preflight pull ${preflight.data.run.id} --source posthog --json`);
  } finally {
    cleanup(root);
  }
});

test('preflight plan does not infer target route from scenario prose', () => {
  const root = tempRoot();
  try {
    run(root, ['init', '--json']);
    const spec = genericSpec({
      id: 'no-scenario-route-heuristic',
      event: 'activation_completed',
      denominatorEvent: 'experiment_viewed',
      preflight: {
        scenarios: [
          {
            id: 'onboarding_path',
            goal: 'Start from /onboarding and complete the activation path.',
            expected_events: ['experiment_viewed', 'activation_completed'],
          },
        ],
      },
    });
    spec.targeting = { domains: ['app'] };
    const specFile = path.join(root, 'spec.json');
    writeFileSync(specFile, JSON.stringify(spec));
    run(root, ['experiment', 'create', 'no-scenario-route-heuristic', '--from-file', specFile, '--json']);

    const plan = run(root, ['preflight', 'plan', 'no-scenario-route-heuristic', '--json']);
    assert.equal(plan.data.plan.target_route, '/');
    assert.equal(plan.data.plan.target_route_source.kind, 'default_root');
    assert.equal(plan.warnings.some((warning) => warning.code === 'TARGET_ROUTE_DEFAULT_ROOT'), true);
    assert.equal(plan.next_steps.some((step) => step.includes('growth project route add')), true);
  } finally {
    cleanup(root);
  }
});

test('preflight packets use explicit experiment scenarios when provided', () => {
  const root = tempRoot();
  try {
    run(root, ['init', '--json']);
    const spec = genericSpec({
      id: 'placeholder',
      event: 'report_exported',
      denominatorEvent: 'report_viewed',
      preflight: {
        scenarios: [
          {
            id: 'report_export_path',
            goal: 'Export a report through the normal product UI.',
            instructions: ['Open a report if one is available.', 'Use the visible export action.'],
            expected_events: ['report_viewed', 'report_exported'],
          },
        ],
      },
    });
    run(root, ['experiment', 'create', 'reports-test', '--from-json', JSON.stringify(spec), '--json']);
    const preflight = run(root, ['preflight', 'prepare', 'reports-test', '--agents', '1', '--json']);
    const packetDir = path.join(root, '.growth', 'runs', preflight.data.run.id, 'agent-packets');
    const policy = JSON.parse(readFileSync(path.join(packetDir, 'agent-1.policy.json'), 'utf8'));
    const prompt = readFileSync(path.join(packetDir, 'agent-1.prompt.txt'), 'utf8');
    assert.equal(policy.scenario.id, 'report_export_path');
    assert.deepEqual(policy.expected_events, ['report_viewed', 'report_exported']);
    assert.match(prompt, /Export a report through the normal product UI/);
    assert.match(prompt, /report_exported/);
  } finally {
    cleanup(root);
  }
});

test('inferred preflight packets separate primary path from guardrail observation', () => {
  const root = tempRoot();
  try {
    run(root, ['init', '--json']);
    const spec = genericSpec({
      id: 'guardrail-split',
      event: 'onboarding_completed',
      denominatorEvent: 'onboarding_started',
    });
    spec.metrics.push({
      id: 'onboarding_error_rate',
      name: 'Onboarding error rate',
      role: 'guardrail',
      type: 'proportion',
      direction: 'lower_is_better',
      event: 'onboarding_error',
      denominator_event: 'onboarding_started',
      guardrail_threshold: 0.05,
    });
    const specFile = path.join(root, 'spec.json');
    writeFileSync(specFile, JSON.stringify(spec));
    run(root, ['experiment', 'create', 'guardrail-split', '--from-file', specFile, '--json']);

    const plan = run(root, ['preflight', 'plan', 'guardrail-split', '--json']);
    assert.deepEqual(plan.data.plan.scenario_expected_events[0].expected_events, [
      'onboarding_started',
      'onboarding_completed',
    ]);
    assert.deepEqual(plan.data.plan.guardrail_events, ['onboarding_error']);

    const preflight = run(root, ['preflight', 'prepare', 'guardrail-split', '--agents', '2', '--json']);
    const packetDir = path.join(root, '.growth', 'runs', preflight.data.run.id, 'agent-packets');
    const primaryPolicy = JSON.parse(readFileSync(path.join(packetDir, 'agent-1.policy.json'), 'utf8'));
    const guardrailPolicy = JSON.parse(readFileSync(path.join(packetDir, 'agent-2.policy.json'), 'utf8'));
    assert.equal(primaryPolicy.scenario.id, 'primary_metric_path');
    assert.deepEqual(primaryPolicy.expected_events, ['onboarding_started', 'onboarding_completed']);
    assert.equal(guardrailPolicy.scenario.id, 'guardrail_metric_observation');
    assert.deepEqual(guardrailPolicy.expected_events, ['onboarding_error', 'onboarding_started']);
  } finally {
    cleanup(root);
  }
});

test('react-vite preflight URLs use framework default and persist explicit app url', () => {
  const root = tempRoot();
  try {
    writeFileSync(
      path.join(root, 'package.json'),
      JSON.stringify({ dependencies: { react: '^19.0.0', vite: '^8.0.0' } }) + '\n',
    );
    run(root, ['init', '--framework', 'react-vite', '--json']);
    run(root, ['experiment', 'create', 'my-test', '--template', 'conversion-test', '--json']);

    const detected = run(root, ['preflight', 'prepare', 'my-test', '--agents', '1', '--json']);
    assert.equal(detected.data.app_url, 'http://localhost:5173');
    let url = readFileSync(
      path.join(root, '.growth', 'runs', detected.data.run.id, 'agent-packets', 'agent-1.url.txt'),
      'utf8',
    ).trim();
    assert.equal(new URL(url).origin, 'http://localhost:5173');

    const explicit = run(root, [
      'preflight',
      'prepare',
      'my-test',
      '--agents',
      '1',
      '--base-url',
      'http://localhost:4444',
      '--json',
    ]);
    assert.equal(explicit.data.run_id, explicit.data.run.id);
    url = readFileSync(
      path.join(root, '.growth', 'runs', explicit.data.run.id, 'agent-packets', 'agent-1.url.txt'),
      'utf8',
    ).trim();
    assert.equal(new URL(url).origin, 'http://localhost:4444');
    const local = JSON.parse(readFileSync(path.join(root, '.growth', 'state.local.json'), 'utf8'));
    assert.equal(local.local_servers.app_url, 'http://localhost:4444');

    const portless = run(root, ['preflight', 'prepare', 'my-test', '--agents', '1', '--json'], {
      env: { PORTLESS_URL: 'https://vite-app.localhost' },
    });
    assert.equal(portless.data.app_url, 'https://vite-app.localhost');
    url = readFileSync(
      path.join(root, '.growth', 'runs', portless.data.run.id, 'agent-packets', 'agent-1.url.txt'),
      'utf8',
    ).trim();
    assert.equal(new URL(url).origin, 'https://vite-app.localhost');
  } finally {
    cleanup(root);
  }
});

test('preflight dry-run audits local JSONL without provider pull', () => {
  const root = tempRoot();
  try {
    run(root, ['init', '--json']);
    run(root, ['experiment', 'create', 'onboarding-flow', '--template', 'onboarding-activation', '--json']);
    mkdirSync(path.join(root, 'tmp'), { recursive: true });
    const events = [];
    let index = 0;
    for (const variant of ['control', 'treatment']) {
      for (const event of onboardingEvents()) {
        events.push(onboardingEventLine('onboarding-flow', `evt-${variant}-${index++}`, event, variant, true));
      }
    }
    writeFileSync(path.join(root, 'tmp', 'events.jsonl'), events.join('\n') + '\n');

    const dryRun = run(root, [
      'preflight',
      'dry-run',
      'onboarding-flow',
      '--events-file',
      'tmp/events.jsonl',
      '--json',
    ]);
    assert.equal(dryRun.data.audit.recommendation, 'ready_for_provider_preflight');
    assert.equal(dryRun.data.audit.checks.find((check) => check.id === 'required_events').status, 'pass');
    assert.equal(dryRun.data.audit.checks.find((check) => check.id === 'synthetic_labels').status, 'pass');
  } finally {
    cleanup(root);
  }
});

test('preflight complete-local finishes prepared run from synthetic JSONL events', () => {
  const root = tempRoot();
  try {
    run(root, ['init', '--json']);
    run(root, ['experiment', 'create', 'onboarding-flow', '--template', 'onboarding-activation', '--json']);
    run(root, ['connector', 'add', 'local', '--events-file', 'tmp/preflight-events.jsonl', '--json']);
    const preflight = run(root, ['preflight', 'prepare', 'onboarding-flow', '--agents', '2', '--json']);
    assert.match(preflight._next.command, /growth preflight complete-local/);
    mkdirSync(path.join(root, 'tmp'), { recursive: true });
    const events = [];
    const eventTimestamp = preflight.data.run.event_window.after;
    for (const [index, agent] of preflight.data.run.agents.entries()) {
      for (const event of onboardingEvents()) {
        events.push(
          preflightEventLine(
            'onboarding-flow',
            `evt-${index}-${event}`,
            event,
            agent.variant_id,
            agent.agent_id,
            eventTimestamp,
          ),
        );
      }
    }
    writeFileSync(path.join(root, 'tmp', 'preflight-events.jsonl'), events.join('\n') + '\n');

    const completed = run(root, [
      'preflight',
      'complete-local',
      preflight.data.run.id,
      '--events-file',
      'tmp/preflight-events.jsonl',
      '--json',
    ]);
    assert.equal(completed.data.run.status, 'completed');
    assert.equal(completed.data.audit.recommendation, 'ready_for_provider_preflight');
    assert.match(completed._next.command, /growth connector import stripe-projects --json/);
    assert.equal(completed.data.audit.checks.find((check) => check.id === 'reports_attached').status, 'pass');
    assert.equal(completed.data.audit.checks.find((check) => check.id === 'required_events').status, 'pass');
    assert.equal(existsSync(path.join(root, completed.data.audit_file)), true);
  } finally {
    cleanup(root);
  }
});

test('preflight dry-run fails and prints synthetic label evidence for unlabeled local events', () => {
  const root = tempRoot();
  try {
    run(root, ['init', '--json']);
    run(root, ['experiment', 'create', 'onboarding-flow', '--template', 'onboarding-activation', '--json']);
    mkdirSync(path.join(root, 'tmp'), { recursive: true });
    const events = onboardingEvents().map((event, index) =>
      onboardingEventLine('onboarding-flow', `evt-${index}`, event, 'control', index !== 0),
    );
    events.push(...onboardingEvents().map((event, index) =>
      onboardingEventLine('onboarding-flow', `evt-treatment-${index}`, event, 'treatment', true),
    ));
    writeFileSync(path.join(root, 'tmp', 'events.jsonl'), events.join('\n') + '\n');

    const dryRun = run(root, [
      'preflight',
      'dry-run',
      'onboarding-flow',
      '--events-file',
      'tmp/events.jsonl',
      '--json',
    ]);
    assert.equal(dryRun.data.audit.recommendation, 'do_not_launch');
    assert.match(dryRun.data.markdown, /Synthetic Label Evidence/);
  } finally {
    cleanup(root);
  }
});

test('preflight dry-run fails invalid event timestamps as untrustworthy evidence', () => {
  const root = tempRoot();
  try {
    run(root, ['init', '--json']);
    run(root, ['experiment', 'create', 'onboarding-flow', '--template', 'onboarding-activation', '--json']);
    mkdirSync(path.join(root, 'tmp'), { recursive: true });
    const events = [];
    for (const variant of ['control', 'treatment']) {
      for (const [index, event] of onboardingEvents().entries()) {
        events.push(onboardingEventLine('onboarding-flow', `evt-${variant}-${index}`, event, variant, true));
      }
    }
    events.push(
      eventLine('onboarding-flow', 'bad-ts', 'experiment_viewed', 'not-a-date', {
        agentGenerated: true,
        agentRunId: 'agent-control',
        userId: 'bad-timestamp-user',
        variant: 'control',
      }),
    );
    writeFileSync(path.join(root, 'tmp', 'events.jsonl'), events.join('\n') + '\n');

    const dryRun = run(root, [
      'preflight',
      'dry-run',
      'onboarding-flow',
      '--events-file',
      'tmp/events.jsonl',
      '--json',
    ]);
    assert.equal(dryRun.data.audit.recommendation, 'fix_app_instrumentation');
    const timestampCheck = dryRun.data.audit.checks.find((check) => check.id === 'event_window_timestamps');
    assert.equal(timestampCheck.status, 'fail');
    assert.equal(timestampCheck.evidence.rejected[0].reason, 'invalid_timestamp');
  } finally {
    cleanup(root);
  }
});

test('removed cohort command is not registered', () => {
  const root = tempRoot();
  try {
    run(root, ['init', '--json']);
    const result = spawnSync(process.execPath, [cli, '--root', root, 'cohort', 'prepare', 'my-test', '--json'], {
      cwd: repoRoot,
      encoding: 'utf8',
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /unknown command 'cohort'/);
  } finally {
    cleanup(root);
  }
});

test('local connector pulls app-emitted JSONL events', () => {
  const root = tempRoot();
  try {
    run(root, ['init', '--json']);
    run(root, ['experiment', 'create', 'my-test', '--template', 'conversion-test', '--json']);
    run(root, ['connector', 'add', 'local', '--events-file', 'tmp/events.jsonl', '--json']);
    mkdirSync(path.join(root, 'tmp'), { recursive: true });
    const events = [
      {
        event: 'experiment_viewed',
        properties: {
          event_id: 'evt-view-1',
          experiment_id: 'my-test',
          variant_id: 'control',
          user_id: 'user-1',
          session_id: 'session-1',
          timestamp: '2026-01-01T00:10:00.000Z',
          agent_generated: true,
          agent_run_id: 'run-1',
        },
      },
      {
        event: 'conversion_completed',
        properties: {
          event_id: 'evt-convert-1',
          experiment_id: 'my-test',
          variant_id: 'control',
          user_id: 'user-1',
          session_id: 'session-1',
          timestamp: '2026-01-01T00:12:00.000Z',
          agent_generated: true,
          agent_run_id: 'run-1',
        },
      },
    ];
    writeFileSync(path.join(root, 'tmp', 'events.jsonl'), events.map((event) => JSON.stringify(event)).join('\n') + '\n');

    const pulled = run(root, [
      'pull',
      'my-test',
      '--source',
      'local',
      '--after',
      '2026-01-01T00:00:00.000Z',
      '--before',
      '2026-01-02T00:00:00.000Z',
      '--json',
    ]);
    assert.equal(pulled.data.raw_fetched, 2);
    assert.equal(pulled.data.emitted, 2);

    const status = run(root, ['status', '--json']);
    assert.equal(status.data.counts.events, 2);
    assert.equal(status.data.counts.assignments, 1);

    const doctor = run(root, ['doctor', 'my-test', '--json']);
    assert.equal(doctor.data.ok, true);
    assert.equal(doctor.data.checks.some((check) => check.name === 'connector_coverage' && check.status === 'pass'), true);
  } finally {
    cleanup(root);
  }
});

test('connector validate for one source requires that source to cover active experiment events', () => {
  const root = tempRoot();
  try {
    run(root, ['init', '--json']);
    run(root, ['experiment', 'create', 'my-test', '--template', 'conversion-test', '--json']);
    run(root, ['connector', 'add', 'local', '--events-file', 'tmp/events.jsonl', '--json']);
    run(root, ['connector', 'add', 'posthog', '--json']);

    const result = run(root, ['connector', 'validate', 'posthog', '--json'], { status: 1 });
    assert.equal(result.ok, false);
    assert.equal(result.error.code, 'connector_coverage_gap');
    assert.deepEqual(result.error.details.missing.sort(), ['conversion_completed', 'experiment_viewed']);
  } finally {
    cleanup(root);
  }
});

test('pull refuses overlapping windows before fetching', () => {
  const root = tempRoot();
  try {
    run(root, ['init', '--json']);
    run(root, ['experiment', 'create', 'my-test', '--template', 'conversion-test', '--json']);
    run(root, ['connector', 'add', 'posthog', '--json']);

    const connectorFile = path.join(root, '.growth', 'connectors', 'posthog.json');
    const connector = JSON.parse(readFileSync(connectorFile, 'utf8'));
    connector.mappings = {
      conversion_completed: {
        framework_event: 'conversion_completed',
        payload_paths: {
          agent_generated: 'properties.agent_generated',
          agent_run_id: 'properties.agent_run_id',
        },
      },
      experiment_viewed: {
        framework_event: 'experiment_viewed',
        payload_paths: {
          agent_generated: 'properties.agent_generated',
          agent_run_id: 'properties.agent_run_id',
        },
      },
    };
    writeFileSync(connectorFile, JSON.stringify(connector, null, 2) + '\n');

    const pullsDir = path.join(root, '.growth', 'runs', 'pull_existing', 'pulls');
    mkdirSync(pullsDir, { recursive: true });
    writeFileSync(
      path.join(pullsDir, 'posthog-existing.json'),
      JSON.stringify(
        {
          source: 'posthog',
          experiment_id: 'my-test',
          run_id: 'pull_existing',
          pull_file: '.growth/runs/pull_existing/pulls/posthog-existing.json',
          window: {
            after: '2026-01-01T00:00:00.000Z',
            before: '2026-01-02T00:00:00.000Z',
          },
          raw_fetched: 0,
          emitted: 0,
          deduped: 0,
          dropped: [],
          per_experiment: {},
          created_at: '2026-01-02T00:00:00.000Z',
        },
        null,
        2,
      ) + '\n',
    );

    const result = run(
      root,
      [
        'pull',
        'my-test',
        '--source',
        'posthog',
        '--after',
        '2026-01-01T12:00:00.000Z',
        '--before',
        '2026-01-01T13:00:00.000Z',
        '--json',
      ],
      { status: 1 },
    );
    assert.equal(result.ok, false);
    assert.equal(result.error.code, 'overlapping_pull_window');
  } finally {
    cleanup(root);
  }
});

test('preflight command is primary and returns structured audit and continuations', () => {
  const root = tempRoot();
  try {
    run(root, ['init', '--json']);
    const created = run(root, ['experiment', 'create', 'onboarding-flow', '--template', 'onboarding-activation', '--json']);
    assert.equal(created._next.command, 'growth instrumentation plan onboarding-flow --json');
    assert.ok(created.data.experiment.instrumentation.events.some((event) => event.event === 'activation_completed'));
    run(root, ['connector', 'add', 'local', '--events-file', 'tmp/events.jsonl', '--json']);

    const preflight = run(root, ['preflight', 'prepare', 'onboarding-flow', '--agents', '2', '--json']);
    assert.match(preflight.data.run.id, /^preflight_/);
    assert.equal(preflight.data.run.type, 'preflight');
    assert.match(preflight._next.command, /growth preflight complete-local/);

    for (let i = 1; i <= 2; i++) {
      const report = path.join(root, `report-${i}.json`);
      writeFileSync(
        report,
        JSON.stringify({
          primary_goal_observed: true,
          stopped_at_url: 'http://localhost:3000/done',
          stop_reason: 'completed',
          path_taken: ['opened app', 'reached primary goal'],
          variant_observed: i === 1 ? 'control' : 'treatment',
          primary_metric_events_observed: ['activation_completed'],
          guardrail_observed: false,
          confusing_or_broken: [],
          blockers: [],
          internal_ui_visible: [],
          missing_expected_events: [],
          screenshot_or_trace_artifacts: [],
        }) + '\n',
      );
      run(root, ['preflight', 'attach-report', preflight.data.run.id, '--agent', String(i), '--file', report, '--json']);
    }

    const audit = run(root, ['preflight', 'audit', preflight.data.run.id, '--json']);
    assert.equal(audit.data.audit.synthetic_only, true);
    assert.equal(audit.data.audit.recommendation, 'fix_app_instrumentation');
    assert.ok(audit.data.audit.checks.some((check) => check.id === 'required_events' && check.status === 'fail'));
  } finally {
    cleanup(root);
  }
});

test('preflight audit requires a configured provider connector for real-user readiness', () => {
  const root = tempRoot();
  try {
    run(root, ['init', '--json']);
    run(root, ['experiment', 'create', 'my-test', '--template', 'conversion-test', '--json']);
    run(root, ['connector', 'add', 'local', '--events-file', 'tmp/events.jsonl', '--json']);
    const preflight = run(root, ['preflight', 'prepare', 'my-test', '--agents', '2', '--json']);
    const runFile = path.join(root, '.growth', 'runs', preflight.data.run.id, 'run.json');
    const preparedRun = JSON.parse(readFileSync(runFile, 'utf8'));
    preparedRun.event_window.after = '2026-01-01T00:00:00.000Z';
    writeFileSync(runFile, JSON.stringify(preparedRun, null, 2) + '\n');

    for (let i = 1; i <= 2; i++) {
      const agent = preflight.data.run.agents[i - 1];
      const report = path.join(root, `report-${i}.json`);
      writeFileSync(
        report,
        JSON.stringify({
          primary_goal_observed: true,
          stopped_at_url: 'http://localhost:3000/done',
          stop_reason: 'completed',
          path_taken: ['opened app', 'converted'],
          variant_observed: agent.variant_id,
          primary_metric_events_observed: ['conversion_completed'],
          guardrail_observed: false,
          confusing_or_broken: [],
          blockers: [],
          internal_ui_visible: [],
          missing_expected_events: [],
          screenshot_or_trace_artifacts: [],
        }) + '\n',
      );
      run(root, ['preflight', 'attach-report', preflight.data.run.id, '--agent', String(i), '--file', report, '--json']);
    }

    mkdirSync(path.join(root, 'tmp'), { recursive: true });
    const baseTs = Date.parse('2026-01-01T00:00:01.000Z');
    const eventLines = preflight.data.run.agents.flatMap((agent, index) => {
      const ts = new Date(baseTs + index * 1000).toISOString();
      return [
        eventLine('my-test', `${agent.agent_id}-view`, 'experiment_viewed', ts, {
          agentGenerated: true,
          agentRunId: agent.agent_id,
          userId: agent.agent_id,
          variant: agent.variant_id,
        }),
        eventLine('my-test', `${agent.agent_id}-convert`, 'conversion_completed', ts, {
          agentGenerated: true,
          agentRunId: agent.agent_id,
          userId: agent.agent_id,
          variant: agent.variant_id,
        }),
      ];
    });
    writeFileSync(path.join(root, 'tmp', 'events.jsonl'), eventLines.join('\n') + '\n');
    run(root, ['preflight', 'complete', preflight.data.run.id, '--json']);
    run(root, ['preflight', 'pull', preflight.data.run.id, '--source', 'local', '--json']);

    const runJson = JSON.parse(readFileSync(runFile, 'utf8'));
    runJson.artifacts.pull_posthog = '.growth/runs/fake/pulls/posthog.json';
    writeFileSync(runFile, JSON.stringify(runJson, null, 2) + '\n');

    const audit = run(root, ['preflight', 'audit', preflight.data.run.id, '--json']);
    assert.equal(audit.data.audit.recommendation, 'ready_for_provider_preflight');
  } finally {
    cleanup(root);
  }
});

test('preflight audit attributes missing preflight events to coverage after local verification passes', () => {
  const root = tempRoot();
  try {
    run(root, ['init', '--json']);
    run(root, ['experiment', 'create', 'onboarding-flow', '--template', 'onboarding-activation', '--json']);
    mkdirSync(path.join(root, 'tmp'), { recursive: true });
    const localEvents = [];
    for (const variant of ['control', 'treatment']) {
      for (const [index, event] of onboardingEvents().entries()) {
        localEvents.push(onboardingEventLine('onboarding-flow', `local-${variant}-${index}`, event, variant, true));
      }
    }
    writeFileSync(path.join(root, 'tmp', 'events.jsonl'), localEvents.join('\n') + '\n');
    const verify = run(root, [
      'instrumentation',
      'verify',
      'onboarding-flow',
      '--events-file',
      'tmp/events.jsonl',
      '--json',
    ]);
    assert.equal(verify.data.actual_event_check.ok, true);

    const preflight = run(root, ['preflight', 'prepare', 'onboarding-flow', '--agents', '2', '--json']);
    for (let i = 1; i <= 2; i++) {
      const report = path.join(root, `report-${i}.json`);
      writeFileSync(report, JSON.stringify(goodReport(i === 1 ? 'control' : 'treatment')) + '\n');
      const attached = run(root, [
        'preflight',
        'attach-report',
        preflight.data.run.id,
        '--agent',
        String(i),
        '--file',
        report,
        '--json',
      ]);
      assert.equal(attached.data.status, 'attached');
      assert.equal(attached.data.schema_validation, 'ok');
      assert.equal(attached.data.agent_id, preflight.data.run.agents[i - 1].agent_id);
    }

    const audit = run(root, ['preflight', 'audit', preflight.data.run.id, '--json']);
    assert.equal(audit.data.audit.recommendation, 'extend_preflight_coverage');
    const required = audit.data.audit.checks.find((check) => check.id === 'required_events');
    assert.equal(required.evidence.attribution, 'synthetic_coverage_gap');
  } finally {
    cleanup(root);
  }
});

test('doctor does not scan source text for SPA navigation heuristics', () => {
  const root = tempRoot();
  try {
    mkdirSync(path.join(root, 'src'), { recursive: true });
    writeFileSync(
      path.join(root, 'src', 'App.tsx'),
      [
        "import { Link } from 'react-router-dom';",
        "const agent = new URLSearchParams(window.location.search).get('agent_generated');",
        "export function App(){ return <Link to='/settings'>{agent}</Link>; }",
      ].join('\n'),
    );
    run(root, ['init', '--json']);
    const doctor = run(root, ['doctor', '--json']);
    const check = doctor.data.checks.find((item) => item.name === 'spa_agent_context');
    assert.equal(check, undefined);
  } finally {
    cleanup(root);
  }
});

test('validate exits nonzero when connector coverage is missing', () => {
  const root = tempRoot();
  try {
    run(root, ['init', '--json']);
    run(root, ['experiment', 'create', 'my-test', '--template', 'conversion-test', '--json']);
    const result = run(root, ['validate', '--json'], { status: 1 });
    assert.equal(result.ok, false);
    assert.equal(result.error.code, 'validation_failed');
    assert.equal(result.error.details.ok, false);
    assert.equal(result.error.details.warnings.some((warning) => warning.code === 'CONNECTOR_COVERAGE_GAP'), true);
  } finally {
    cleanup(root);
  }
});

test('env set can source values from process env without echoing the secret', () => {
  const root = tempRoot();
  try {
    run(root, ['init', '--json']);
    const set = run(
      root,
      ['env', 'set', '--key', 'POSTHOG_ANALYTICS_API_KEY', '--from-env', 'SOURCE_POSTHOG_KEY', '--json'],
      { env: { SOURCE_POSTHOG_KEY: 'phx_secret_value' } },
    );
    assert.equal(set.data.source.from_env, 'SOURCE_POSTHOG_KEY');
    assert.equal(set.data.value, '[redacted]');
    assert.doesNotMatch(JSON.stringify(set), /phx_secret_value/);
    assert.match(readFileSync(path.join(root, '.env.local'), 'utf8'), /POSTHOG_ANALYTICS_API_KEY="phx_secret_value"/);
  } finally {
    cleanup(root);
  }
});

test('env set rejects literal values that would land in process args', () => {
  const root = tempRoot();
  try {
    run(root, ['init', '--json']);
    const result = run(
      root,
      ['env', 'set', '--key', 'POSTHOG_ANALYTICS_API_KEY', '--value', 'phx_secret_value', '--json'],
      { status: 1 },
    );
    assert.equal(result.error.code, 'unsafe_secret_argument');
    assert.doesNotMatch(JSON.stringify(result), /phx_secret_value/);
  } finally {
    cleanup(root);
  }
});

test('env set rejects empty stdin values', () => {
  const root = tempRoot();
  try {
    run(root, ['init', '--json']);
    const result = spawnSync(
      process.execPath,
      [cli, '--root', root, 'env', 'set', '--key', 'POSTHOG_PROJECT_ID', '--stdin', '--json'],
      {
        cwd: repoRoot,
        encoding: 'utf8',
        input: '',
      },
    );
    assert.equal(result.status, 1);
    const envelope = JSON.parse(result.stdout);
    assert.equal(envelope.error.code, 'empty_env_value');
  } finally {
    cleanup(root);
  }
});

test('posthog connector uses variant_id canonically while accepting legacy variant fallback', () => {
  const root = tempRoot();
  try {
    run(root, ['init', '--json']);
    run(root, ['experiment', 'create', 'my-test', '--template', 'conversion-test', '--json']);
    const connector = run(root, ['connector', 'add', 'posthog', '--json']);
    assert.equal(connector.data.connector.variant_id_path, 'properties.variant_id');

    mkdirSync(path.join(root, 'tmp'), { recursive: true });
    writeFileSync(
      path.join(root, 'tmp', 'events.jsonl'),
      [
        legacyVariantEventLine('my-test', 'legacy-view', 'experiment_viewed', 'control'),
        legacyVariantEventLine('my-test', 'legacy-convert', 'conversion_completed', 'treatment'),
      ].join('\n') + '\n',
    );
    const dryRun = run(root, ['preflight', 'dry-run', 'my-test', '--events-file', 'tmp/events.jsonl', '--json']);
    assert.equal(dryRun.data.audit.checks.find((check) => check.id === 'variant_reachability').status, 'pass');
  } finally {
    cleanup(root);
  }
});

test('pull cursors are scoped by source and experiment', () => {
  const root = tempRoot();
  try {
    run(root, ['init', '--json']);
    run(root, ['experiment', 'create', 'test-a', '--template', 'conversion-test', '--json']);
    run(root, ['experiment', 'create', 'test-b', '--template', 'conversion-test', '--json']);
    run(root, ['connector', 'add', 'local', '--events-file', 'tmp/events.jsonl', '--json']);
    mkdirSync(path.join(root, 'tmp'), { recursive: true });
    const base = Date.now() - 60 * 60 * 1000;
    const iso = (offsetMs) => new Date(base + offsetMs).toISOString();
    const after = new Date(base - 60_000).toISOString();
    const before = new Date(base + 600_000).toISOString();
    writeFileSync(
      path.join(root, 'tmp', 'events.jsonl'),
      [
        eventLine('test-a', 'evt-a-view', 'experiment_viewed', iso(0)),
        eventLine('test-a', 'evt-a-convert', 'conversion_completed', iso(60_000)),
        eventLine('test-b', 'evt-b-view', 'experiment_viewed', iso(120_000)),
        eventLine('test-b', 'evt-b-convert', 'conversion_completed', iso(180_000)),
      ].join('\n') + '\n',
    );

    run(root, [
      'pull',
      'test-a',
      '--source',
      'local',
      '--after',
      after,
      '--before',
      before,
      '--json',
    ]);
    const b = run(root, ['pull', 'test-b', '--source', 'local', '--before', before, '--json']);
    assert.equal(b.data.emitted, 2);
    const cursors = JSON.parse(readFileSync(path.join(root, '.growth', 'data', 'pull-cursors.json'), 'utf8'));
    assert.ok(cursors.local['test-a']);
    assert.ok(cursors.local['test-b']);
  } finally {
    cleanup(root);
  }
});

test('simulate clear requires confirmation and default append is non-destructive', () => {
  const root = tempRoot();
  try {
    run(root, ['init', '--json']);
    run(root, ['experiment', 'create', 'my-test', '--template', 'conversion-test', '--json']);
    run(root, ['simulate', 'my-test', '--days', '1', '--daily', '10', '--json']);
    const first = run(root, ['status', '--json']).data.counts.events;
    const rejected = run(root, ['simulate', 'my-test', '--clear', '--json'], { status: 1 });
    assert.equal(rejected.error.code, 'confirmation_required');
    run(root, ['simulate', 'my-test', '--days', '1', '--daily', '10', '--json']);
    const second = run(root, ['status', '--json']).data.counts.events;
    assert.ok(second > first);
    run(root, ['--yes', 'simulate', 'my-test', '--days', '1', '--daily', '10', '--clear', '--json']);
    const cleared = run(root, ['status', '--json']).data.counts.events;
    assert.ok(cleared <= second);
  } finally {
    cleanup(root);
  }
});

test('connector state records custom env names and stripe projects import', () => {
  const root = tempRoot();
  try {
    run(root, ['init', '--json']);
    run(root, [
      'connector',
      'add',
      'posthog',
      '--project-id',
      'CUSTOM_POSTHOG_PROJECT',
      '--api-key-env',
      'CUSTOM_POSTHOG_KEY',
      '--json',
    ]);
    let state = JSON.parse(readFileSync(path.join(root, '.growth', 'state.json'), 'utf8'));
    assert.deepEqual(state.connectors.posthog.required_env, ['CUSTOM_POSTHOG_KEY', 'CUSTOM_POSTHOG_PROJECT']);

    rmSync(path.join(root, '.growth', 'connectors', 'posthog.json'), { force: true });
    delete state.connectors.posthog;
    writeFileSync(path.join(root, '.growth', 'state.json'), JSON.stringify(state, null, 2) + '\n');
    mkdirSync(path.join(root, '.projects'), { recursive: true });
    writeFileSync(
      path.join(root, '.projects', 'state.json'),
      JSON.stringify({
        services: {
          posthog: {
            host: 'https://eu.posthog.com',
            project_id_env: 'IMPORTED_POSTHOG_PROJECT',
            api_key_env: 'IMPORTED_POSTHOG_KEY',
          },
        },
      }) + '\n',
    );
    const imported = run(root, ['connector', 'import', 'stripe-projects', '--json']);
    assert.equal(imported.data.connector.posthog.host, 'https://eu.posthog.com');
    state = JSON.parse(readFileSync(path.join(root, '.growth', 'state.json'), 'utf8'));
    assert.deepEqual(state.connectors.posthog.required_env, ['IMPORTED_POSTHOG_KEY', 'IMPORTED_POSTHOG_PROJECT']);
  } finally {
    cleanup(root);
  }
});

test('connector auth setup has a uniform ready shape when auth is not required', () => {
  const root = tempRoot();
  try {
    run(root, ['init', '--json']);
    run(root, ['connector', 'add', 'local', '--json']);

    const setup = run(root, ['connector', 'auth', 'setup', 'local', '--json']);
    assert.equal(setup.data.ready, true);
    assert.equal(setup.data.resolution, 'ready');
    assert.equal(setup.data.blocked, false);
    assert.equal(setup.data.manual_input_required, false);
    assert.deepEqual(setup.data.safe_commands, []);
    assert.equal(setup.data.retry_command, 'growth connector auth check local --json');
    assert.equal(setup._next.command, 'growth connector validate local --json');
  } finally {
    cleanup(root);
  }
});

test('stripe projects import recognizes prefixed posthog env output', () => {
  const root = tempRoot();
  try {
    run(root, ['init', '--json']);
    writeFileSync(
      path.join(root, '.env'),
      [
        'POSTHOG_ANALYTICS_API_KEY=phc_test',
        'POSTHOG_ANALYTICS_HOST=https://us.posthog.com',
        '',
      ].join('\n'),
    );

    const imported = run(root, ['connector', 'import', 'stripe-projects', '--json']);
    assert.equal(imported.data.connector.posthog.host, 'https://us.posthog.com');
    assert.equal(imported.data.connector.posthog.project_id, undefined);
    assert.equal(imported.data.connector.posthog.api_key_env, 'POSTHOG_ANALYTICS_API_KEY');
    assert.equal(
      imported.data.connector.mappings.activation_completed.payload_paths.agent_generated,
      'properties.agent_generated',
    );

    const auth = run(root, ['connector', 'auth', 'check', 'posthog', '--json']);
    assert.equal(auth.data.project_id_required_for_provider_pull, true);
    assert.equal(auth.data.project_id_configured, false);
    assert.equal(auth.data.project_id_present, false);
    assert.equal(auth.data.api_key_present, true);
    assert.equal(auth.data.capabilities.telemetry_write.ready, true);
    assert.equal(auth.data.capabilities.provider_pull.ready, false);
    assert.deepEqual(auth.data.capabilities.provider_pull.missing, ['project_id']);
    assert.deepEqual(auth.data.missing, ['project_id']);
    assert.equal(auth.data.setup_command, 'growth connector auth setup posthog --json');
    assert.equal(auth._next.command, 'growth connector auth setup posthog --json');

    const setup = run(root, ['connector', 'auth', 'setup', 'posthog', '--json']);
    assert.equal(setup.data.ready, false);
    assert.equal(setup.data.resolution, 'manual_input_required');
    assert.equal(setup.data.blocked, true);
    assert.equal(setup.data.manual_input_required, true);
    assert.equal(setup.data.telemetry_write_ready, true);
    assert.equal(setup.data.provider_pull_ready, false);
    assert.deepEqual(setup.data.safe_commands, ['growth env set --key POSTHOG_PROJECT_ID --stdin']);
    assert.equal(setup.data.retry_command, 'growth connector auth check posthog --json');
    assert.equal(setup.data.stop_reason.includes('Stop automated provider preflight'), true);
    assert.equal(setup.data.missing_requirements.length, 1);
    assert.equal(setup.data.missing_requirements[0].id, 'posthog-provider-pull-project-id');
    assert.equal(setup.data.missing_requirements[0].capability, 'provider_pull');
    assert.equal(setup.data.missing_requirements[0].env, 'POSTHOG_PROJECT_ID');
    assert.deepEqual(setup.data.missing_requirements[0].safe_commands, [
      'growth env set --key POSTHOG_PROJECT_ID --stdin',
    ]);
    assert.equal(setup.data.policy.do_not_read_env_files_directly, true);
    assert.equal(setup.data.policy.do_not_probe_provider_apis_directly, true);
    assert.equal(JSON.stringify(setup).includes('phc_test'), false);
    assert.equal(setup._next, undefined);

    const state = JSON.parse(readFileSync(path.join(root, '.growth', 'state.json'), 'utf8'));
    assert.deepEqual(state.connectors.posthog.required_env, ['POSTHOG_ANALYTICS_API_KEY']);
  } finally {
    cleanup(root);
  }
});

test('stripe projects import accepts post hog analytics host alias', () => {
  const root = tempRoot();
  try {
    run(root, ['init', '--json']);
    writeFileSync(
      path.join(root, '.env'),
      [
        'POSTHOG_ANALYTICS_API_KEY=phc_test',
        'POST_HOG_ANALYTICS_HOST=https://eu.posthog.com',
        '',
      ].join('\n'),
    );

    const imported = run(root, ['connector', 'import', 'stripe-projects', '--json']);
    assert.equal(imported.data.connector.posthog.host, 'https://eu.posthog.com');
    assert.equal(imported.data.connector.posthog.api_key_env, 'POSTHOG_ANALYTICS_API_KEY');
  } finally {
    cleanup(root);
  }
});

test('growth mcp exposes tool list', () => {
  const result = spawnSync(
    process.execPath,
    [path.join(repoRoot, 'dist', 'mcp.js')],
    {
      cwd: repoRoot,
      encoding: 'utf8',
      input:
        JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }) +
        '\n' +
        JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }) +
        '\n',
    },
  );
  assert.equal(result.status, 0);
  const lines = result.stdout.trim().split('\n').map((line) => JSON.parse(line));
  assert.equal(lines[0].result.serverInfo.name, 'growth');
  const auditTool = lines[1].result.tools.find((tool) => tool.name === 'growth_preflight_audit');
  assert.ok(auditTool);
  assert.equal(auditTool.inputSchema.properties.args, undefined);
  assert.deepEqual(auditTool.inputSchema.required, ['run_id']);
  assert.equal(auditTool.inputSchema.properties.run_id.type, 'string');
});

function eventLine(experimentId, eventId, event, timestamp, options = {}) {
  const variant = options.variant ?? 'control';
  const userId = options.userId ?? `user-${experimentId}`;
  const agentGenerated = options.agentGenerated ?? true;
  const agentRunId = options.agentRunId === undefined ? `run-${experimentId}` : options.agentRunId;
  return JSON.stringify({
    event,
    properties: {
      event_id: eventId,
      experiment_id: experimentId,
      variant_id: variant,
      user_id: userId,
      session_id: options.sessionId ?? `session-${userId}`,
      timestamp,
      agent_generated: agentGenerated,
      agent_run_id: agentRunId,
    },
  });
}

function onboardingEvents() {
  return [
    'experiment_viewed',
    'onboarding_started',
    'onboarding_step_viewed',
    'onboarding_step_completed',
    'onboarding_completed',
    'activation_completed',
    'onboarding_error',
    'auth_blocked',
    'internal_ui_visible',
    'support_or_help_clicked',
  ];
}

function onboardingEventLine(experimentId, eventId, event, variant, labeled) {
  return JSON.stringify({
    event,
    properties: {
      event_id: eventId,
      experiment_id: experimentId,
      variant_id: variant,
      user_id: `user-${variant}`,
      session_id: `session-${variant}`,
      timestamp: '2026-01-01T00:00:00.000Z',
      agent_generated: labeled ? true : undefined,
      agent_run_id: labeled ? `agent-${variant}` : undefined,
    },
  });
}

function preflightEventLine(
  experimentId,
  eventId,
  event,
  variant,
  agentRunId,
  timestamp = '2026-01-01T00:00:00.000Z',
) {
  return JSON.stringify({
    event,
    properties: {
      event_id: eventId,
      experiment_id: experimentId,
      variant_id: variant,
      user_id: `user-${agentRunId}`,
      session_id: `session-${agentRunId}`,
      timestamp,
      agent_generated: true,
      agent_run_id: agentRunId,
    },
  });
}

function legacyVariantEventLine(experimentId, eventId, event, variant) {
  return JSON.stringify({
    event,
    properties: {
      event_id: eventId,
      experiment_id: experimentId,
      variant,
      user_id: `user-${variant}`,
      session_id: `session-${variant}`,
      timestamp: '2026-01-01T00:00:00.000Z',
      agent_generated: true,
      agent_run_id: `agent-${variant}`,
    },
  });
}

function genericSpec({ id, event, denominatorEvent, preflight }) {
  return {
    id,
    name: 'Generic experiment',
    hypothesis:
      'We believe changing this product surface will improve the primary metric because users will have a clearer path.',
    status: 'draft',
    variants: [
      { id: 'control', name: 'Control', weight: 50 },
      { id: 'treatment', name: 'Treatment', weight: 50 },
    ],
    metrics: [
      {
        id: 'primary_rate',
        name: 'Primary rate',
        role: 'primary',
        type: 'proportion',
        direction: 'higher_is_better',
        event,
        denominator_event: denominatorEvent,
      },
    ],
    sample_size: {
      baseline_rate: 0.2,
      minimum_detectable_effect: 0.15,
      power: 0.8,
      alpha: 0.05,
    },
    schedule: { max_duration_days: 30, min_runtime_days: 7 },
    preflight,
  };
}

function goodReport(variant) {
  return {
    primary_goal_observed: true,
    stopped_at_url: 'http://localhost:3000/done',
    stop_reason: 'completed',
    path_taken: ['opened app', 'reached primary goal'],
    variant_observed: variant,
    primary_metric_events_observed: ['activation_completed'],
    guardrail_observed: false,
    confusing_or_broken: [],
    blockers: [],
    internal_ui_visible: [],
    missing_expected_events: [],
    screenshot_or_trace_artifacts: [],
  };
}
