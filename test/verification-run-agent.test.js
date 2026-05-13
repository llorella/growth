import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const repoRoot = path.resolve(import.meta.dirname, '..');
const runner = path.join(repoRoot, 'verification', 'scripts', 'run-agent.mjs');

function tempRoot() {
  return mkdtempSync(path.join(tmpdir(), 'growth-verification-runner-'));
}

function cleanup(root) {
  rmSync(root, { recursive: true, force: true });
}

function runProcess(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? repoRoot,
    encoding: 'utf8',
    env: { ...process.env, ...(options.env ?? {}) },
  });
  const expectedStatus = options.status ?? 0;
  assert.equal(
    result.status,
    expectedStatus,
    `expected exit ${expectedStatus}, got ${result.status}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
  );
  return result;
}

function createTarget(root) {
  const targetRepo = path.join(root, 'target-repo');
  runProcess('git', ['init', targetRepo]);
  runProcess('git', ['config', 'user.email', 'growth-test@example.com'], { cwd: targetRepo });
  runProcess('git', ['config', 'user.name', 'Growth Test'], { cwd: targetRepo });
  writeFileSync(path.join(targetRepo, 'README.md'), '# Target\n');
  runProcess('git', ['add', 'README.md'], { cwd: targetRepo });
  runProcess('git', ['commit', '-m', 'init'], { cwd: targetRepo });

  const promptFile = path.join(root, 'prompt.md');
  writeFileSync(promptFile, 'Use Growth.\n');
  const targetFile = path.join(root, 'target.json');
  writeFileSync(
    targetFile,
    JSON.stringify(
      {
        id: 'tmp-target',
        repo: targetRepo,
        prompt: promptFile,
      },
      null,
      2,
    ) + '\n',
  );
  return targetFile;
}

function runAgent(root, targetFile, agentScript, options = {}) {
  const runDir = path.join(root, options.runId ?? 'run');
  const result = runProcess(
    process.execPath,
    [
      runner,
      '--target',
      targetFile,
      '--run-dir',
      runDir,
      '--run-id',
      options.runId ?? 'run',
      '--no-build',
      '--force',
      '--agent-command',
      `${process.execPath} ${agentScript}`,
    ],
    { status: options.status ?? 0 },
  );
  return {
    output: JSON.parse(result.stdout),
    run: JSON.parse(readFileSync(path.join(runDir, 'run.json'), 'utf8')),
    runDir,
  };
}

test('verification runner promotes Growth usage audit summary into run metadata', () => {
  const root = tempRoot();
  try {
    const targetFile = createTarget(root);
    const agentScript = path.join(root, 'agent-completed.mjs');
    writeFileSync(
      agentScript,
      `const commands = ${JSON.stringify([
        'growth status --json',
        'growth llm-context --json',
        'growth instrumentation plan onboarding --json',
        'growth instrumentation verify onboarding --json',
        'growth preflight run onboarding --json',
        'growth connector auth setup posthog --json',
      ])};
for (const [index, command] of commands.entries()) {
  console.log(JSON.stringify({
    type: 'item.completed',
    item: {
      id: 'item_' + index,
      type: 'command_execution',
      command,
      aggregated_output: '',
      exit_code: 0,
      status: 'completed'
    }
  }));
}
`,
    );

    const { output, run, runDir } = runAgent(root, targetFile, agentScript, { runId: 'completed' });
    assert.equal(output.growth_usage_audit_status, 'scored');
    assert.equal(output.growth_usage_score, 100);
    assert.equal(output.growth_usage_grade, 'excellent');
    assert.deepEqual(output.growth_usage_anti_pattern_ids, []);
    assert.equal(run.growth_usage_audit_status, 'scored');
    assert.equal(run.growth_usage_artifact, 'artifacts/growth-usage-audit.json');
    const audit = JSON.parse(readFileSync(path.join(runDir, 'artifacts', 'growth-usage-audit.json'), 'utf8'));
    assert.equal(audit.grade, 'excellent');
  } finally {
    cleanup(root);
  }
});

test('verification runner skips Growth usage audit when agent is unavailable', () => {
  const root = tempRoot();
  try {
    const targetFile = createTarget(root);
    const agentScript = path.join(root, 'agent-unavailable.mjs');
    writeFileSync(
      agentScript,
      "console.log(\"You've hit your usage limit. try again at 11:26 PM.\"); process.exit(1);\n",
    );

    const { output, run, runDir } = runAgent(root, targetFile, agentScript, {
      runId: 'unavailable',
      status: 1,
    });
    assert.equal(output.status, 'agent_unavailable');
    assert.equal(output.agent_failure_reason, 'usage_limit');
    assert.equal(output.growth_usage_audit_status, 'skipped_agent_unavailable');
    assert.equal(run.growth_usage_audit_status, 'skipped_agent_unavailable');
    assert.throws(() => readFileSync(path.join(runDir, 'artifacts', 'growth-usage-audit.json')));
  } finally {
    cleanup(root);
  }
});
