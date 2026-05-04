import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
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
    const analysis = run(root, ['analyze', 'my-test', '--json']);
    assert.equal(analysis.data.recommendation.action, 'synthetic_only_no_ship');
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

    run(root, ['init', '--json']);
    assert.equal(existsSync(path.join(root, '.agents', 'skills', 'growth', 'references', 'nextjs-app-router.md')), true);
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
    assert.deepEqual(plan.data.suggested_files.includes('app/utils/events.ts'), true);
    assert.deepEqual(plan.data.suggested_files.includes('app/api/events/route.ts'), true);
    assert.deepEqual(plan.data.suggested_files.some((file) => file.startsWith('src/')), false);
    assert.deepEqual(plan.data.preflight_query_params.map((param) => param.name), [
      'agent_generated',
      'agent_run_id',
      'experiment_id',
      'variant',
    ]);
    assert.equal(plan.data.required_contract.assignment.stable_by, 'anonymous_id');
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
    assert.equal(
      verify.warnings.some((warning) => warning.code === 'ACTUAL_EVENT_PROPERTY_MISSING'),
      true,
    );
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
    writeFileSync(badReport, JSON.stringify({ completed_onboarding: true }) + '\n');
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
        completed_onboarding: true,
        stopped_at_url: 'http://localhost:3000/done',
        stop_reason: 'completed',
        path_taken: ['opened app', 'finished onboarding'],
        conversion_observed: true,
        guardrail_issue_observed: false,
        confusing_or_broken: [],
        internal_ui_visible: [],
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
    assert.match(audit.data.markdown, /Completed onboarding: 1 \/ 1/);
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

    const preflight = run(root, ['preflight', 'prepare', 'onboarding-flow', '--agents', '2', '--json']);
    assert.match(preflight.data.run.id, /^preflight_/);
    assert.equal(preflight.data.run.type, 'preflight');
    assert.match(preflight._next.command, /growth preflight attach-report/);

    for (let i = 1; i <= 2; i++) {
      const report = path.join(root, `report-${i}.json`);
      writeFileSync(
        report,
        JSON.stringify({
          completed_onboarding: true,
          stopped_at_url: 'http://localhost:3000/done',
          stop_reason: 'completed',
          path_taken: ['opened app', 'finished onboarding'],
          variant_observed: i === 1 ? 'control' : 'treatment',
          conversion_observed: true,
          activation_observed: true,
          guardrail_issue_observed: false,
          confusing_or_broken: [],
          auth_or_payment_blockers: [],
          internal_ui_visible: [],
          missing_expected_events: [],
          screenshot_or_trace_artifacts: [],
        }) + '\n',
      );
      run(root, ['preflight', 'attach-report', preflight.data.run.id, '--agent', String(i), '--file', report, '--json']);
    }

    const audit = run(root, ['preflight', 'audit', preflight.data.run.id, '--json']);
    assert.equal(audit.data.audit.synthetic_only, true);
    assert.equal(audit.data.audit.recommendation, 'fix_instrumentation');
    assert.ok(audit.data.audit.checks.some((check) => check.id === 'required_events' && check.status === 'fail'));
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

test('stripe projects import recognizes prefixed posthog env output', () => {
  const root = tempRoot();
  try {
    run(root, ['init', '--json']);
    writeFileSync(
      path.join(root, '.env'),
      [
        'POSTHOG_ANALYTICS_API_KEY=phc_test',
        'POSTHOG_ANALYTICS_HOST=https://us.posthog.com',
        'POSTHOG_ANALYTICS_PERSONAL_API_KEY=phx_test',
        'POSTHOG_ANALYTICS_PROJECT_ID=12345',
        '',
      ].join('\n'),
    );

    const imported = run(root, ['connector', 'import', 'stripe-projects', '--json']);
    assert.equal(imported.data.connector.posthog.host, 'https://us.posthog.com');
    assert.equal(imported.data.connector.posthog.project_id, 'POSTHOG_ANALYTICS_PROJECT_ID');
    assert.equal(imported.data.connector.posthog.api_key_env, 'POSTHOG_ANALYTICS_PERSONAL_API_KEY');
    assert.equal(
      imported.data.connector.mappings.activation_completed.payload_paths.agent_generated,
      'properties.agent_generated',
    );

    const auth = run(root, ['connector', 'auth', 'check', 'posthog', '--json']);
    assert.equal(auth.data.project_id_present, true);
    assert.equal(auth.data.api_key_present, true);

    const state = JSON.parse(readFileSync(path.join(root, '.growth', 'state.json'), 'utf8'));
    assert.deepEqual(state.connectors.posthog.required_env, [
      'POSTHOG_ANALYTICS_PERSONAL_API_KEY',
      'POSTHOG_ANALYTICS_PROJECT_ID',
    ]);
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
  assert.ok(lines[1].result.tools.some((tool) => tool.name === 'growth_preflight_audit'));
});

function eventLine(experimentId, eventId, event, timestamp) {
  return JSON.stringify({
    event,
    properties: {
      event_id: eventId,
      experiment_id: experimentId,
      variant_id: 'control',
      user_id: `user-${experimentId}`,
      session_id: `session-${experimentId}`,
      timestamp,
      agent_generated: true,
      agent_run_id: `run-${experimentId}`,
    },
  });
}
