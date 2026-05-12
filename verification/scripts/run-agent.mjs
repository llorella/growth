#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { cp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const opts = parseArgs(process.argv.slice(2));

if (opts.help || !opts.target) {
  process.stdout.write(usage());
  process.exit(opts.help ? 0 : 1);
}

const targetFile = path.resolve(repoRoot, opts.target);
const target = JSON.parse(await readFile(targetFile, 'utf8'));
const runId = opts.runId ?? `${target.id}-${timestampId()}`;
const runDir = path.resolve(repoRoot, opts.runDir ?? path.join('verification/runs', runId));
const worktree = path.join(runDir, 'worktree');
const tracesDir = path.join(runDir, 'traces');
const binDir = path.join(runDir, 'bin');
const promptFile = path.join(runDir, 'prompt.md');
const runFile = path.join(runDir, 'run.json');
const targetRepo = expandHome(target.repo);
const baseRef = target.baseRef ?? 'HEAD';

await assertRunDirAvailable(runDir, opts.force);
await mkdir(tracesDir, { recursive: true });
await mkdir(binDir, { recursive: true });

if (!opts.noBuild) {
  await run('npm', ['run', 'build'], { cwd: repoRoot, stdoutFile: path.join(tracesDir, 'build.stdout.log'), stderrFile: path.join(tracesDir, 'build.stderr.log') });
}

await run('git', ['-C', targetRepo, 'worktree', 'add', '--detach', worktree, baseRef], {
  stdoutFile: path.join(tracesDir, 'worktree-add.stdout.log'),
  stderrFile: path.join(tracesDir, 'worktree-add.stderr.log'),
});

const copiedEnvFiles = await copyEnvFiles(target.envFiles);
await writeGrowthShim();

const renderedPrompt = await renderPrompt(target, runId, worktree);
await writeFile(promptFile, renderedPrompt);
await writeRun({ status: opts.agentCommand ? 'agent_running' : 'prepared', copied_env_files: copiedEnvFiles });

if (!opts.agentCommand) {
  process.stdout.write(
    JSON.stringify(
      {
        status: 'prepared',
        run_id: runId,
        run_dir: path.relative(repoRoot, runDir),
        worktree,
        prompt_file: path.relative(repoRoot, promptFile),
        next: 'Rerun with --agent-command "<command>" to execute an agent.',
      },
      null,
      2,
    ) + '\n',
  );
  process.exit(0);
}

const command = opts.agentCommand.replaceAll('{{WORKTREE}}', shellQuote(worktree)).replaceAll('{{RUN_DIR}}', shellQuote(runDir));
const agentResult = await runShell(command, {
  cwd: worktree,
  input: renderedPrompt,
  env: {
    ...process.env,
    PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ''}`,
    GROWTH_VERIFICATION_RUN_ID: runId,
    GROWTH_VERIFICATION_RUN_DIR: runDir,
  },
  stdoutFile: path.join(tracesDir, 'agent.stdout.log'),
  stderrFile: path.join(tracesDir, 'agent.stderr.log'),
  allowFailure: true,
});

await writeRun({ status: agentResult.status === 0 ? 'agent_completed' : 'agent_failed', agent_exit_code: agentResult.status });

await run('node', ['verification/scripts/collect-artifacts.mjs', '--target', opts.target, '--run-dir', path.relative(repoRoot, runDir), '--worktree', worktree], {
  cwd: repoRoot,
  stdoutFile: path.join(tracesDir, 'collect.stdout.log'),
  stderrFile: path.join(tracesDir, 'collect.stderr.log'),
});

if (!opts.keep) {
  await run('git', ['-C', targetRepo, 'worktree', 'remove', '--force', worktree], {
    stdoutFile: path.join(tracesDir, 'worktree-remove.stdout.log'),
    stderrFile: path.join(tracesDir, 'worktree-remove.stderr.log'),
    allowFailure: true,
  });
}

await writeRun({ status: agentResult.status === 0 ? 'completed' : 'agent_failed', agent_exit_code: agentResult.status });

process.stdout.write(
  JSON.stringify(
    {
      status: agentResult.status === 0 ? 'completed' : 'agent_failed',
      run_id: runId,
      run_dir: path.relative(repoRoot, runDir),
      artifacts_dir: path.relative(repoRoot, path.join(runDir, 'artifacts')),
      traces_dir: path.relative(repoRoot, tracesDir),
      agent_exit_code: agentResult.status,
    },
    null,
    2,
  ) + '\n',
);

if (agentResult.status !== 0) process.exitCode = 1;

function usage() {
  return `Usage: node verification/scripts/run-agent.mjs --target <target.json> [options]

Options:
  --agent-command <cmd>  Shell command that reads the prompt on stdin.
  --run-id <id>          Stable run id. Defaults to <target>-<timestamp>.
  --run-dir <dir>        Run directory. Defaults to verification/runs/<run_id>.
  --keep                 Keep the target worktree after collection.
  --force                Remove an existing run directory before starting.
  --no-build             Do not run npm run build before exposing growth.
  --help                 Show this message.
`;
}

async function renderPrompt(targetConfig, id, dir) {
  const promptPath = path.resolve(repoRoot, targetConfig.prompt);
  const raw = await readFile(promptPath, 'utf8');
  return raw.replaceAll('{{TARGET_DIR}}', dir).replaceAll('{{RUN_ID}}', id);
}

async function writeGrowthShim() {
  const shim = path.join(binDir, 'growth');
  await writeFile(shim, `#!/usr/bin/env bash\nexec node ${shellQuote(path.join(repoRoot, 'dist/index.js'))} "$@"\n`);
  await run('chmod', ['755', shim]);
}

async function copyEnvFiles(envFiles) {
  if (envFiles == null) return [];
  if (!Array.isArray(envFiles)) throw new Error('target.envFiles must be an array of repo-relative file paths.');

  const copied = [];
  for (const rel of envFiles) {
    if (typeof rel !== 'string' || rel.length === 0) {
      throw new Error('target.envFiles entries must be non-empty strings.');
    }
    if (path.isAbsolute(rel) || rel.split(/[\\/]/).includes('..')) {
      throw new Error(`target.envFiles entries must stay within the target repo: ${rel}`);
    }

    const source = path.join(targetRepo, rel);
    const destination = path.join(worktree, rel);
    const sourceStat = await stat(source).catch((err) => {
      throw new Error(`Configured env file is missing: ${source}`, { cause: err });
    });
    if (!sourceStat.isFile()) throw new Error(`Configured env file is not a file: ${source}`);

    await mkdir(path.dirname(destination), { recursive: true });
    await cp(source, destination, { force: true, preserveTimestamps: true });
    copied.push(rel);
  }
  return copied;
}

async function writeRun(patch) {
  let existing = {};
  try {
    existing = JSON.parse(await readFile(runFile, 'utf8'));
  } catch {
    existing = {};
  }
  await writeFile(
    runFile,
    JSON.stringify(
      {
        id: runId,
        target: target.id,
        target_file: path.relative(repoRoot, targetFile),
        target_repo: targetRepo,
        base_ref: baseRef,
        run_dir: path.relative(repoRoot, runDir),
        worktree,
        prompt_file: path.relative(repoRoot, promptFile),
        created_at: existing.created_at ?? new Date().toISOString(),
        ...existing,
        ...patch,
        updated_at: new Date().toISOString(),
      },
      null,
      2,
    ) + '\n',
  );
}

async function assertRunDirAvailable(dir, force) {
  try {
    await stat(dir);
    if (!force) throw new Error(`Run directory already exists: ${dir}. Use --force or --run-id.`);
    await run('git', ['-C', targetRepo, 'worktree', 'remove', '--force', worktree], { allowFailure: true });
    await rm(dir, { recursive: true, force: true });
  } catch (err) {
    if (err?.code !== 'ENOENT') throw err;
  }
}

function parseArgs(args) {
  const out = {};
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--help' || arg === '-h') out.help = true;
    else if (arg === '--keep') out.keep = true;
    else if (arg === '--force') out.force = true;
    else if (arg === '--no-build') out.noBuild = true;
    else if (arg.startsWith('--')) out[toCamel(arg.slice(2))] = args[++i];
    else throw new Error(`Unexpected argument: ${arg}`);
  }
  return out;
}

function toCamel(value) {
  return value.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
}

function expandHome(value) {
  if (value === '~') return process.env.HOME ?? value;
  if (value?.startsWith('~/')) return path.join(process.env.HOME ?? '', value.slice(2));
  return value;
}

function timestampId() {
  return new Date().toISOString().replace(/[-:.]/g, '').slice(0, 15);
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

async function run(command, args, options = {}) {
  return runProcess(command, args, { ...options, shell: false });
}

async function runShell(command, options = {}) {
  return runProcess(command, [], { ...options, shell: true });
}

async function runProcess(command, args, options) {
  const child = spawn(command, args, {
    cwd: options.cwd ?? repoRoot,
    env: options.env ?? process.env,
    shell: options.shell,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  child.stdin.on('error', (err) => {
    if (err?.code !== 'EPIPE') throw err;
  });
  if (options.input) child.stdin.end(options.input);
  else child.stdin.end();
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => {
    stdout += chunk;
  });
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
  });
  const status = await new Promise((resolve) => child.on('close', resolve));
  if (options.stdoutFile) await writeFile(options.stdoutFile, stdout);
  if (options.stderrFile) await writeFile(options.stderrFile, stderr);
  if (status !== 0 && !options.allowFailure) {
    throw new Error(`${command} ${args.join(' ')} exited ${status}: ${stderr || stdout}`);
  }
  return { status, stdout, stderr };
}
