#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { chmod, mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createInterface } from 'node:readline/promises';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
if (argv.includes('--help') || argv.includes('-h')) {
  process.stdout.write(usage());
  process.exit(0);
}

const DEFAULT_EXCLUDES = new Set([
  '.git',
  'node_modules',
  '.next',
  'dist',
  'build',
  'coverage',
  '.turbo',
  '.vercel',
  '.cache',
]);

const opts = parseArgs(argv);
const runId = opts.id ?? timestampId();
const phase = opts.phase ?? 'full';
const runsDir = path.resolve(repoRoot, opts.runsDir ?? 'outerloop/runs');
const runDir = path.join(runsDir, runId);
const appDir = path.join(runDir, 'app');
const binDir = path.join(runDir, 'bin');
const promptsDir = path.join(runDir, 'prompts');
const tracesDir = path.join(runDir, 'traces');
const artifactsDir = path.join(runDir, 'artifacts');
const browserDir = path.join(artifactsDir, 'browser');

const growthBin = path.join(binDir, 'growth');
const growthCommand = opts.growthCommand ?? 'growth';
const stripeProjectsCommand = opts.stripeProjectsCommand ?? 'stripe projects';
const stripeProjectName = opts.stripeProjectName ?? runId;
const posthogOrganizationName = opts.posthogOrganizationName ?? titleFromId(stripeProjectName);

await main();

async function main() {
  await mkdir(appDir, { recursive: true });
  await mkdir(binDir, { recursive: true });
  await mkdir(promptsDir, { recursive: true });
  await mkdir(tracesDir, { recursive: true });
  await mkdir(artifactsDir, { recursive: true });
  await mkdir(browserDir, { recursive: true });

  await requireCommand('codex');
  await requireCommand('claude');
  await requireCommand('agent-browser');
  await requireCommand(stripeProjectsCommand.split(/\s+/)[0]);
  await writeGrowthShim();
  validatePhase(phase);

  const env = {
    ...process.env,
    PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ''}`,
    OUTERLOOP_RUN_ID: runId,
    OUTERLOOP_RUN_DIR: runDir,
    OUTERLOOP_APP_DIR: appDir,
    AGENT_BROWSER_SCREENSHOT_DIR: browserDir,
    AGENT_BROWSER_SESSION: `outerloop-${runId}`,
    AGENT_BROWSER_SESSION_NAME: `outerloop-${runId}`,
  };

  const builderPrompt = await loadPrompt(opts.builderPrompt, defaultBuilderPrompt());
  const rolloutPrompt = await loadPrompt(
    opts.rolloutPrompt,
    defaultRolloutPrompt({ manualProviderSetup: !!opts.pauseAfterBuilder || !!opts.manualProviderSetup || phase === 'rollout-only' }),
  );
  await writeFile(path.join(promptsDir, 'builder.md'), builderPrompt);
  await writeFile(path.join(promptsDir, 'rollout.md'), rolloutPrompt);

  await writeFile(
    path.join(runDir, 'run.json'),
    JSON.stringify(
      {
        id: runId,
        created_at: new Date().toISOString(),
        app_dir: appDir,
        commands: {
          builder: 'codex exec',
          rollout: 'claude -p',
          browser: 'agent-browser',
          stripe_projects: stripeProjectsCommand,
          growth: growthCommand,
        },
      },
      null,
      2,
    ) + '\n',
  );

  let baseline;
  if (phase === 'rollout-only' || phase === 'evaluate-only') {
    baseline = JSON.parse(await readFile(path.join(artifactsDir, 'baseline-manifest.json'), 'utf8'));
  } else {
    await runBuilder(builderPrompt, env);
    baseline = await manifest(appDir);
    await writeFile(path.join(artifactsDir, 'baseline-manifest.json'), JSON.stringify(baseline, null, 2) + '\n');
    await writeBuilderCheckpoint(env);
    const manualSetup = await writeManualProviderSetup();
    if (phase === 'builder-only') {
      printManualProviderInstructions(manualSetup, { exitAfterBuilder: true });
      return;
    }
    if (opts.pauseAfterBuilder) await pauseForManualProviderSetup(manualSetup);
  }

  if (phase !== 'evaluate-only') {
    await runRollout(rolloutPrompt, env);
  } else {
    await writeRolloutSessionSummary();
  }
  const after = await manifest(appDir);
  await writeFile(path.join(artifactsDir, 'after-manifest.json'), JSON.stringify(after, null, 2) + '\n');

  const evaluation = await evaluate({ baseline, after });
  await writeFile(path.join(runDir, 'evaluation.json'), JSON.stringify(evaluation, null, 2) + '\n');
  process.stdout.write(JSON.stringify(evaluation, null, 2) + '\n');

  if (!evaluation.pass) process.exitCode = 1;
}

async function runBuilder(prompt, env) {
  const args = [
    'exec',
    '--json',
    '--dangerously-bypass-approvals-and-sandbox',
    '--skip-git-repo-check',
    '--cd',
    appDir,
    '--output-last-message',
    path.join(tracesDir, 'builder-final.txt'),
    '-',
  ];
  if (opts.builderModel) args.splice(1, 0, '--model', opts.builderModel);
  await runCommand('codex', args, {
    cwd: appDir,
    env,
    input: prompt,
    stdoutFile: path.join(tracesDir, 'builder-events.jsonl'),
    stderrFile: path.join(tracesDir, 'builder-stderr.log'),
  });
}

async function runRollout(prompt, env) {
  const args = [
    '-p',
    '--output-format',
    'stream-json',
    '--verbose',
    '--dangerously-skip-permissions',
    '--tools',
    'default',
  ];
  if (opts.rolloutModel) args.push('--model', opts.rolloutModel);
  try {
    await runCommand('claude', args, {
      cwd: appDir,
      env: withoutClaudeApiKeyEnv(env),
      input: prompt,
      stdoutFile: path.join(tracesDir, 'rollout-events.jsonl'),
      stderrFile: path.join(tracesDir, 'rollout-stderr.log'),
    });
  } finally {
    await writeRolloutSessionSummary();
  }
}

function withoutClaudeApiKeyEnv(env) {
  const out = { ...env };
  for (const key of Object.keys(out)) {
    if (/^(ANTHROPIC|CLAUDE|CLAUDE_CODE)_.*API_?KEY$/i.test(key) || /^ANTHROPIC_API_KEY$/i.test(key)) {
      delete out[key];
    }
  }
  return out;
}

async function evaluate({ baseline, after }) {
  const growthDir = path.join(appDir, '.growth');
  const projectsDir = path.join(appDir, '.projects');
  const stripeProjectsDir = path.join(appDir, '.stripe-projects');
  const rolloutTrace = await readText(path.join(tracesDir, 'rollout-events.jsonl'));
  const rolloutErr = await readText(path.join(tracesDir, 'rollout-stderr.log'));
  const allRolloutText = `${rolloutTrace}\n${rolloutErr}`;

  const preflightRuns = await listDirs(path.join(growthDir, 'runs'), (name) => name.startsWith('preflight_'));
  const auditFiles = [];
  for (const run of preflightRuns) {
    const audit = path.join(growthDir, 'runs', run, 'audit.md');
    if (await exists(audit)) auditFiles.push(audit);
  }
  const auditText = (await Promise.all(auditFiles.map(readText))).join('\n');

  const checks = [
    check('builder_created_app_files', after.files.length > 0, {
      files: after.files.length,
    }),
    check('baseline_had_no_growth_state', !baseline.files.some((file) => file.path.startsWith('.growth/'))),
    check('baseline_had_no_stripe_projects_state', !baseline.files.some((file) => file.path.startsWith('.projects/') || file.path.startsWith('.stripe-projects/'))),
    check('rollout_invoked_stripe_projects', /stripe\s+projects|stripe-projects/.test(allRolloutText)),
    check('rollout_invoked_growth', /\bgrowth\b/.test(allRolloutText)),
    check('rollout_invoked_agent_browser', /\bagent-browser\b/.test(allRolloutText)),
    check('growth_state_exists', await exists(path.join(growthDir, 'state.json'))),
    check('posthog_connector_exists', await exists(path.join(growthDir, 'connectors', 'posthog.json'))),
    check('experiment_exists', (await listFiles(path.join(growthDir, 'experiments'), (name) => name.endsWith('.json'))).length > 0),
    check('preflight_run_exists', preflightRuns.length > 0, { preflight_runs: preflightRuns }),
    check('preflight_audit_exists', auditFiles.length > 0, { audit_files: auditFiles.map((file) => path.relative(runDir, file)) }),
    check('preflight_ready_for_real_users', /Recommendation:\s*ready_for_real_users/.test(auditText)),
    check('no_known_secret_leakage', !(await leakedSecretNames(runDir)).length, {
      leaked_secret_names: await leakedSecretNames(runDir),
    }),
  ];

  return {
    id: runId,
    app_dir: appDir,
    pass: checks.every((item) => item.ok),
    checks,
    artifacts: {
      prompts_dir: promptsDir,
      traces_dir: tracesDir,
      browser_dir: browserDir,
      rollout_session: path.join(artifactsDir, 'rollout-session.json'),
      baseline_manifest: path.join(artifactsDir, 'baseline-manifest.json'),
      after_manifest: path.join(artifactsDir, 'after-manifest.json'),
    },
    changed_files: diffManifest(baseline, after),
    generated_at: new Date().toISOString(),
  };
}

function defaultBuilderPrompt() {
  return `Build a normal end-to-end SaaS app in the current directory.

Requirements:
- Build a realistic onboarding/activation SaaS app for teams.
- Include signup/login-ish flow, workspace creation, invite step, dashboard, settings, and pricing or billing placeholder.
- Include persistent local data suitable for local development.
- Include README with install, dev, test, and usage commands.
- Use ordinary app conventions and tests for the stack you choose.

You may install packages and use the network. Finish by summarizing how to run the app.`;
}

function defaultRolloutPrompt({ manualProviderSetup = false } = {}) {
  const providerSetup = manualProviderSetup
    ? `Provider setup may already be present in this directory. Start by verifying it with: ${stripeProjectsCommand} status --json, ${stripeProjectsCommand} services list --json, and ${stripeProjectsCommand} env --json. If Stripe Projects or PostHog env are missing, document the exact command a human must run and stop instead of looping on browser auth.`
    : `Use Stripe Projects for real provider/env setup or discovery. Start with: ${stripeProjectsCommand} status --json`;

  return `The current directory contains an existing SaaS app. Your job is to add and validate a real onboarding/activation experiment.

Hard requirements:
- ${providerSetup}
- Use growth as the experiment control plane. Start with growth --help and growth status --json.
- Do not hand-edit .growth state or .growth/data files.
- Do not read or print raw secrets. Use provider CLIs and env names, not secret values.
- Use a real PostHog connector imported from Stripe Projects. Do not fall back to a fake provider path.
- Use agent-browser CLI for browser automation and preflight exercise.
- Use synthetic preflight before launch.
- Never treat agent-generated traffic as real-user evidence.

Expected workflow:
1. Inspect the app and run its tests or dev checks.
2. Run Stripe Projects status/env commands to make provider context available.
3. Run growth init --json.
4. Run growth connector import stripe-projects --json.
5. Run growth connector auth check posthog --json and growth connector validate posthog --json.
6. Create an onboarding activation experiment with growth experiment create onboarding-flow --template onboarding-activation --json.
7. Run growth instrumentation plan onboarding-flow --json.
8. Edit the app to implement assignment, variants, and required events.
9. Use agent-browser to exercise the app locally. Capture screenshots/traces under ${browserDir}.
10. Run growth instrumentation verify onboarding-flow --events-file tmp/events.jsonl --json when local events exist.
11. Run growth preflight prepare onboarding-flow --agents 4 --browser --json.
12. Use agent-browser to execute each generated preflight packet URL.
13. Attach agent reports, complete the preflight, pull from PostHog, and run growth preflight audit.

Finish only after the latest preflight audit is ready_for_real_users, or after documenting the exact blocker if that is impossible.`;
}

async function runCommand(command, args, options) {
  const stdout = createWriteStream(options.stdoutFile, { flags: 'w' });
  const stderr = createWriteStream(options.stderrFile, { flags: 'w' });
  const stdoutDone = streamDone(stdout);
  const stderrDone = streamDone(stderr);
  await writeFile(options.stderrFile + '.cmd.json', JSON.stringify({ command, args, cwd: options.cwd }, null, 2) + '\n');
  const code = await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    child.stdout.pipe(stdout);
    child.stderr.pipe(stderr);
    child.on('error', reject);
    child.on('close', (code) => {
      resolve(code);
    });
    child.stdin.end(options.input);
  });
  await Promise.all([stdoutDone, stderrDone]);
  if (code !== 0) {
    throw new Error(await commandFailureMessage(command, code, options));
  }
}

function streamDone(stream) {
  return new Promise((resolve, reject) => {
    stream.on('finish', resolve);
    stream.on('error', reject);
  });
}

async function commandFailureMessage(command, code, options) {
  const parts = [`${command} exited ${code}.`];
  const claude = command === 'claude' ? await summarizeClaudeStream(options.stdoutFile) : null;
  if (claude) parts.push(claude);

  const stderrTail = lastNonEmptyLines(await readText(options.stderrFile), 8);
  if (stderrTail) {
    parts.push(`stderr tail:\n${stderrTail}`);
  } else if (!claude) {
    const stdoutTail = lastNonEmptyLines(await readText(options.stdoutFile), 8);
    if (stdoutTail) parts.push(`stdout tail:\n${stdoutTail}`);
  }

  parts.push(`See ${options.stderrFile}`);
  if (options.stdoutFile) parts.push(`See ${options.stdoutFile}`);
  return parts.join('\n');
}

async function summarizeClaudeStream(file) {
  const lines = (await readText(file)).split('\n').filter(Boolean);
  let init = null;
  let result = null;
  let rateLimit = null;

  for (const line of lines) {
    const event = parseJsonLine(line);
    if (!event) continue;
    if (!init && event.type === 'system' && event.subtype === 'init') init = event;
    if (event.type === 'rate_limit_event') rateLimit = event.rate_limit_info;
    if (event.type === 'result') result = event;
  }

  const details = [];
  if (result?.is_error || result?.api_error_status) {
    const status = result.api_error_status ? `status ${result.api_error_status}` : 'error';
    const text = result.result ? `: ${result.result}` : '';
    details.push(`Claude result ${status}${text}`);
  } else if (result?.result) {
    details.push(`Claude result: ${result.result}`);
  }
  if (rateLimit?.status === 'rejected') {
    details.push(`Claude rate limit rejected: ${describeRateLimit(rateLimit)}`);
  }
  if (init?.session_id) details.push(`Claude session: ${init.session_id}`);
  if (init?.apiKeySource) details.push(`Claude apiKeySource: ${init.apiKeySource}`);
  return details.length ? details.join('\n') : '';
}

function parseJsonLine(line) {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

function describeRateLimit(rateLimit) {
  const parts = [rateLimit.rateLimitType].filter(Boolean);
  if (rateLimit.overageStatus) parts.push(`overage=${rateLimit.overageStatus}`);
  if (rateLimit.overageDisabledReason) parts.push(rateLimit.overageDisabledReason);
  if (rateLimit.resetsAt) parts.push(`resets=${new Date(rateLimit.resetsAt * 1000).toLocaleString()}`);
  return parts.join(', ');
}

function lastNonEmptyLines(text, count) {
  return text
    .split('\n')
    .map((line) => line.trimEnd())
    .filter(Boolean)
    .slice(-count)
    .join('\n');
}

async function writeBuilderCheckpoint(env) {
  await requireCommand('tar');
  const tarFile = path.join(artifactsDir, 'builder-checkpoint.tar.gz');
  await runCommand('tar', [
    '-czf',
    tarFile,
    '--exclude=./node_modules',
    '--exclude=./.git',
    '--exclude=./dist',
    '--exclude=./build',
    '--exclude=./coverage',
    '--exclude=./.next',
    '-C',
    appDir,
    '.',
  ], {
    cwd: appDir,
    env,
    input: '',
    stdoutFile: path.join(tracesDir, 'builder-checkpoint-stdout.log'),
    stderrFile: path.join(tracesDir, 'builder-checkpoint-stderr.log'),
  });
  return tarFile;
}

async function writeManualProviderSetup() {
  const script = path.join(artifactsDir, 'manual-provider-setup.sh');
  const lines = [
    '#!/usr/bin/env bash',
    'set -euo pipefail',
    '',
    `cd ${shellQuote(appDir)}`,
    'echo "Running Stripe Projects setup in: $PWD"',
    '',
    `${stripeProjectsCommand} init ${shellQuote(stripeProjectName)} --yes --accept-tos`,
    `${stripeProjectsCommand} status --json`,
    `${stripeProjectsCommand} add posthog/free --provider-config ${shellQuote(JSON.stringify({ region: 'US', organization_name: posthogOrganizationName }))} --json --yes --accept-tos`,
    `${stripeProjectsCommand} add posthog/analytics --parent --json --yes --accept-tos`,
    `${stripeProjectsCommand} env --refresh --pull --json`,
    `${stripeProjectsCommand} env --json`,
    '',
  ];
  await writeFile(script, lines.join('\n'));
  await chmod(script, 0o755);

  const markdown = path.join(artifactsDir, 'manual-provider-setup.md');
  await writeFile(
    markdown,
    [
      `# Manual Provider Setup: ${runId}`,
      '',
      `Builder app directory: ${appDir}`,
      '',
      'Run:',
      '',
      '```bash',
      script,
      '```',
      '',
      'If Stripe opens a browser confirmation URL, complete it in your normal browser, then let the command finish.',
      '',
      'The script provisions PostHog through Stripe Projects and writes env files into the app directory.',
      '',
    ].join('\n'),
  );
  return { script, markdown };
}

async function pauseForManualProviderSetup(manualSetup) {
  printManualProviderInstructions(manualSetup, { exitAfterBuilder: false });
  if (!process.stdin.isTTY) {
    throw new Error('--pause-after-builder requires an interactive terminal so the harness can wait for Enter.');
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    await rl.question('Press Enter after the manual provider setup command finishes...');
  } finally {
    rl.close();
  }
}

function printManualProviderInstructions(manualSetup, { exitAfterBuilder }) {
  process.stdout.write(`\nBuilder phase complete for ${runId}.\n`);
  process.stdout.write(`App directory: ${appDir}\n`);
  process.stdout.write(`Baseline manifest: ${path.join(artifactsDir, 'baseline-manifest.json')}\n`);
  process.stdout.write(`Builder checkpoint: ${path.join(artifactsDir, 'builder-checkpoint.tar.gz')}\n\n`);
  process.stdout.write('Manual provider setup command:\n\n');
  process.stdout.write(`  ${manualSetup.script}\n\n`);
  process.stdout.write(`Detailed instructions: ${manualSetup.markdown}\n`);
  if (exitAfterBuilder) process.stdout.write('\nBuilder-only phase complete. Rerun with --phase rollout-only after setup.\n');
  else process.stdout.write('\nAfter that command completes, return here and press Enter to start Claude rollout.\n\n');
}

async function writeRolloutSessionSummary() {
  const trace = await readText(path.join(tracesDir, 'rollout-events.jsonl'));
  const session = trace
    .split('\n')
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .find((event) => event?.session_id);
  if (!session?.session_id) return;
  await writeFile(
    path.join(artifactsDir, 'rollout-session.json'),
    JSON.stringify(
      {
        session_id: session.session_id,
        cwd: appDir,
        resume_command: `cd ${shellQuote(appDir)} && claude --resume ${session.session_id}`,
      },
      null,
      2,
    ) + '\n',
  );
}

async function writeGrowthShim() {
  const target = path.join(repoRoot, 'dist', 'index.js');
  const body = `#!/usr/bin/env bash\nexec node ${JSON.stringify(target)} "$@"\n`;
  await writeFile(growthBin, body);
  await chmod(growthBin, 0o755);
}

async function requireCommand(command) {
  if (await findOnPath(command)) return;
  throw new Error(`Required command not found on PATH: ${command}`);
}

async function findOnPath(command) {
  if (command.includes('/')) return (await exists(command)) ? command : null;
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
    const candidate = path.join(dir, command);
    if (await exists(candidate)) return candidate;
  }
  return null;
}

async function manifest(root) {
  const files = [];
  await walk(root, '', files);
  files.sort((a, b) => a.path.localeCompare(b.path));
  return { root, files };
}

async function walk(root, rel, files) {
  const dir = path.join(root, rel);
  let entries = [];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (DEFAULT_EXCLUDES.has(entry.name)) continue;
    const childRel = rel ? `${rel}/${entry.name}` : entry.name;
    const full = path.join(root, childRel);
    if (entry.isDirectory()) {
      await walk(root, childRel, files);
    } else if (entry.isFile()) {
      const s = await stat(full);
      files.push({ path: childRel, bytes: s.size, sha256: await sha256(full) });
    }
  }
}

function diffManifest(before, after) {
  const b = new Map(before.files.map((file) => [file.path, file.sha256]));
  const a = new Map(after.files.map((file) => [file.path, file.sha256]));
  const added = [];
  const modified = [];
  const removed = [];
  for (const [file, hash] of a) {
    if (!b.has(file)) added.push(file);
    else if (b.get(file) !== hash) modified.push(file);
  }
  for (const file of b.keys()) {
    if (!a.has(file)) removed.push(file);
  }
  return { added, modified, removed };
}

async function leakedSecretNames(root) {
  const secrets = Object.entries(process.env)
    .filter(([key, value]) => /KEY|TOKEN|SECRET|PASSWORD/i.test(key) && typeof value === 'string' && value.length >= 12)
    .map(([key, value]) => ({ key, value }));
  if (!secrets.length) return [];
  const files = (await manifest(root)).files.filter((file) => file.bytes <= 500_000);
  const leaked = new Set();
  for (const file of files) {
    const text = await readText(path.join(root, file.path));
    for (const secret of secrets) {
      if (text.includes(secret.value)) leaked.add(secret.key);
    }
  }
  return Array.from(leaked).sort();
}

async function sha256(file) {
  return createHash('sha256').update(await readFile(file)).digest('hex');
}

async function exists(file) {
  try {
    await stat(file);
    return true;
  } catch {
    return false;
  }
}

async function listDirs(dir, filter = () => true) {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    return entries.filter((entry) => entry.isDirectory() && filter(entry.name)).map((entry) => entry.name).sort();
  } catch {
    return [];
  }
}

async function listFiles(dir, filter = () => true) {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    return entries.filter((entry) => entry.isFile() && filter(entry.name)).map((entry) => entry.name).sort();
  } catch {
    return [];
  }
}

async function readText(file) {
  try {
    return await readFile(file, 'utf8');
  } catch {
    return '';
  }
}

function check(id, ok, evidence = undefined) {
  return { id, ok: Boolean(ok), ...(evidence === undefined ? {} : { evidence }) };
}

async function loadPrompt(file, fallback) {
  if (!file) return fallback;
  return readFile(path.resolve(file), 'utf8');
}

function timestampId() {
  return new Date().toISOString().replace(/[-:.]/g, '').replace('T', 'T').slice(0, 15) + 'Z';
}

function usage() {
  return `Usage: node outerloop/run.mjs --id <run-id> [options]

Options:
  --id <id>                              Run id.
  --builder-model <model>                Model passed to codex exec.
  --rollout-model <model>                Model passed to claude -p.
  --stripe-projects-command <command>    Stripe Projects command prefix. Default: "stripe projects".
  --phase <full|builder-only|rollout-only|evaluate-only>
  --pause-after-builder                  Stop after builder, print provider setup script, wait for Enter, then run rollout.
  --manual-provider-setup                Use rollout prompt variant that verifies already-prepared Stripe/PostHog setup.
  --stripe-project-name <name>           Stripe Projects project name. Default: run id.
  --posthog-organization-name <name>     PostHog organization name. Default: title-cased project name.
  --builder-prompt <file>                Override builder prompt.
  --rollout-prompt <file>                Override rollout prompt.
  --runs-dir <dir>                       Runs directory. Default: outerloop/runs.
`;
}

function validatePhase(value) {
  const allowed = new Set(['full', 'builder-only', 'rollout-only', 'evaluate-only']);
  if (!allowed.has(value)) throw new Error(`Invalid --phase ${value}. Expected one of: ${Array.from(allowed).join(', ')}`);
}

function titleFromId(value) {
  return value
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function parseArgs(args) {
  const booleans = new Set(['pauseAfterBuilder', 'manualProviderSetup']);
  const out = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (!arg.startsWith('--')) throw new Error(`Unexpected argument: ${arg}`);
    const key = arg.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    const value = args[i + 1];
    if (booleans.has(key) && (!value || value.startsWith('--'))) {
      out[key] = true;
      continue;
    }
    if (!value || value.startsWith('--')) throw new Error(`Missing value for ${arg}`);
    out[key] = booleans.has(key) ? value !== 'false' : value;
    i++;
  }
  return out;
}
