import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const repoRoot = path.resolve(import.meta.dirname, '..');
const analyzer = path.join(repoRoot, 'verification', 'scripts', 'analyze-run.mjs');

function tempRun() {
  const root = mkdtempSync(path.join(tmpdir(), 'growth-verification-analyzer-'));
  mkdirSync(path.join(root, 'traces'), { recursive: true });
  return root;
}

function cleanup(root) {
  rmSync(root, { recursive: true, force: true });
}

function writeTrace(root, commands) {
  const lines = commands.map((command, index) =>
    JSON.stringify({
      type: 'item.completed',
      item: {
        id: `item_${index}`,
        type: 'command_execution',
        command,
        aggregated_output: '',
        exit_code: 0,
        status: 'completed',
      },
    }),
  );
  writeFileSync(path.join(root, 'traces', 'agent.stdout.log'), lines.join('\n') + '\n');
}

function analyze(root) {
  const result = spawnSync(process.execPath, [analyzer, '--run-dir', root], {
    cwd: repoRoot,
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  return JSON.parse(result.stdout);
}

test('verification analyzer flags raw env and provider API anti-patterns', () => {
  const root = tempRun();
  try {
    writeTrace(root, [
      'growth status --json',
      'growth llm-context --json',
      'growth instrumentation plan onboarding --json',
      'growth instrumentation verify onboarding --json',
      'growth preflight plan onboarding --json',
      'node -e "require(\'dotenv\').config({path:\'.env\'}); fetch(\'https://us.posthog.com/api/projects/\')"',
    ]);

    const audit = analyze(root);
    assert.equal(audit.grade, 'poor');
    assert.deepEqual(audit.anti_pattern_counts, {
      raw_env_read: 1,
      direct_provider_api_probe: 1,
    });
    assert.equal(audit.anti_patterns.some((item) => item.id === 'raw_env_read'), true);
    assert.equal(audit.anti_patterns.some((item) => item.id === 'direct_provider_api_probe'), true);
    assert.equal(readFileSync(path.join(root, 'artifacts', 'growth-usage-audit.json'), 'utf8').includes('raw_env_read'), true);
  } finally {
    cleanup(root);
  }
});

test('verification analyzer recognizes control-plane-only Growth usage', () => {
  const root = tempRun();
  try {
    writeTrace(root, [
      'growth init --json',
      'growth llm-context --json',
      'growth instrumentation plan onboarding --json',
      'growth instrumentation verify onboarding --json',
      'growth preflight run onboarding --json',
      'growth connector auth setup posthog --json',
    ]);

    const audit = analyze(root);
    assert.equal(audit.grade, 'excellent');
    assert.deepEqual(audit.anti_pattern_counts, {});
    assert.deepEqual(audit.anti_patterns, []);
    assert.deepEqual(audit.missing_required, []);
    assert.equal(audit.required.preflight_planned, true);
    assert.equal(audit.preflight.run_attempted, true);
    assert.deepEqual(audit.preflight_gaps, []);
  } finally {
    cleanup(root);
  }
});

test('verification analyzer separates planned preflight from explicit blockers', () => {
  const root = tempRun();
  try {
    const blockedOutput = JSON.stringify({
      data: {
        plan: {
          readiness: { current: 'blocked' },
          evidence: {
            blocked_sources: [
              {
                capability: 'provider_pull',
                manual_input_required: true,
              },
            ],
          },
        },
      },
    });
    writeTrace(root, [
      'growth init --json',
      'growth llm-context --json',
      'growth instrumentation plan onboarding --json',
      'growth instrumentation verify onboarding --json',
      'growth preflight plan onboarding --json',
      'growth connector auth setup posthog --json',
    ]);
    const traceFile = path.join(root, 'traces', 'agent.stdout.log');
    const trace = readFileSync(traceFile, 'utf8')
      .trim()
      .split('\n')
      .map((line) => {
        const item = JSON.parse(line);
        if (item.item.command === 'growth preflight plan onboarding --json') {
          item.item.aggregated_output = blockedOutput;
        }
        return JSON.stringify(item);
      })
      .join('\n');
    writeFileSync(traceFile, trace + '\n');

    const audit = analyze(root);
    assert.equal(audit.preflight.planned, true);
    assert.equal(audit.preflight.run_attempted, false);
    assert.equal(audit.preflight.blocked_with_reason, true);
    assert.deepEqual(audit.preflight_gaps, []);
    assert.equal(audit.grade, 'excellent');
  } finally {
    cleanup(root);
  }
});

test('verification analyzer does not count growth path references as commands', () => {
  const root = tempRun();
  try {
    writeTrace(root, [
      "sed -n '1,220p' .agents/skills/growth/workflows/create-experiment.md",
      'growth status --json',
    ]);

    const audit = analyze(root);
    assert.equal(audit.growth_command_count, 1);
    assert.deepEqual(audit.growth_commands, ['growth status --json']);
    assert.equal(audit.required.growth_status_or_init, true);
    assert.equal(audit.required.growth_llm_context, false);
  } finally {
    cleanup(root);
  }
});
