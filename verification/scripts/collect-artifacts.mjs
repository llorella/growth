#!/usr/bin/env node
import { cp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const opts = parseArgs(process.argv.slice(2));

if (opts.help || !opts.target || !opts.runDir || !opts.worktree) {
  process.stdout.write(usage());
  process.exit(opts.help ? 0 : 1);
}

const targetFile = path.resolve(repoRoot, opts.target);
const target = JSON.parse(await readFile(targetFile, 'utf8'));
const runDir = path.resolve(repoRoot, opts.runDir);
const worktree = path.resolve(opts.worktree);
const artifactsDir = path.join(runDir, 'artifacts');
const growthOut = path.join(artifactsDir, 'growth');

await mkdir(artifactsDir, { recursive: true });

await writeCommand('git-status.txt', ['git', 'status', '--short', '--ignored', '--', '.', ...sensitivePathspecExcludes()]);
const untrackedFiles = await readUntrackedFiles();
await writeGitDiffArtifacts(untrackedFiles);
await writeUntrackedList(untrackedFiles);

await rm(growthOut, { recursive: true, force: true });
if (await exists(path.join(worktree, '.growth'))) {
  await cp(path.join(worktree, '.growth'), growthOut, {
    recursive: true,
    filter: (source) => shouldCopyGrowthPath(path.relative(path.join(worktree, '.growth'), source)),
  });
}

const growthFiles = [];
if (await exists(growthOut)) await walk(growthOut, growthFiles);
growthFiles.sort();
await writeFile(
  path.join(artifactsDir, 'growth-files.txt'),
  growthFiles.map((file) => path.relative(growthOut, file)).join('\n') + (growthFiles.length ? '\n' : ''),
);

const codex = await readCodexMetadata();
if (codex) {
  await writeFile(path.join(artifactsDir, 'codex.json'), JSON.stringify(codex, null, 2) + '\n');
}

await writeFile(
  path.join(artifactsDir, 'metadata.json'),
  JSON.stringify(
    {
      target: target.id,
      target_file: path.relative(repoRoot, targetFile),
      worktree,
      collected_at: new Date().toISOString(),
      growth_files: growthFiles.length,
      untracked_files: untrackedFiles.length,
      codex_thread_id: codex?.thread_id ?? null,
      codex_session_log: codex?.session_log ?? null,
    },
    null,
    2,
  ) + '\n',
);

process.stdout.write(
  JSON.stringify(
    {
      ok: true,
      run_dir: path.relative(repoRoot, runDir),
      artifacts_dir: path.relative(repoRoot, artifactsDir),
      growth_files: growthFiles.length,
      untracked_files: untrackedFiles.length,
      codex_thread_id: codex?.thread_id ?? null,
    },
    null,
    2,
  ) + '\n',
);

function usage() {
  return `Usage: node verification/scripts/collect-artifacts.mjs --target <target.json> --run-dir <dir> --worktree <dir>\n`;
}

function parseArgs(args) {
  const out = {};
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--help' || arg === '-h') out.help = true;
    else if (arg.startsWith('--')) out[toCamel(arg.slice(2))] = args[++i];
    else throw new Error(`Unexpected argument: ${arg}`);
  }
  return out;
}

function toCamel(value) {
  return value.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
}

async function exists(file) {
  try {
    await stat(file);
    return true;
  } catch {
    return false;
  }
}

function shouldCopyGrowthPath(rel) {
  if (!rel) return true;
  const normalized = rel.split(path.sep).join('/');
  if (normalized === 'state.local.json') return false;
  if (normalized === 'audit.jsonl') return false;
  if (normalized === 'data' || normalized.startsWith('data/')) return false;
  if (/^runs\/[^/]+\/secrets(\/|$)/.test(normalized)) return false;
  return true;
}

async function walk(dir, out) {
  const entries = await import('node:fs/promises').then((fs) => fs.readdir(dir, { withFileTypes: true }));
  for (const entry of entries) {
    const child = path.join(dir, entry.name);
    if (entry.isDirectory()) await walk(child, out);
    else out.push(child);
  }
}

async function writeGitDiffArtifacts(untrackedFiles) {
  const trackedStat = await commandArtifact(['git', 'diff', '--stat', '--', '.', ...sensitivePathspecExcludes()]);
  const trackedPatch = await commandArtifact(['git', 'diff', '--binary', '--', '.', ...sensitivePathspecExcludes()]);
  const untrackedStat = await untrackedDiffArtifact(untrackedFiles, ['--stat']);
  const untrackedPatch = await untrackedDiffArtifact(untrackedFiles, ['--binary']);

  await writeFile(path.join(artifactsDir, 'git-diff-tracked.patch'), trackedPatch);
  await writeFile(path.join(artifactsDir, 'git-diff-untracked.patch'), untrackedPatch);
  await writeFile(path.join(artifactsDir, 'git-diff.patch'), [trackedPatch, untrackedPatch].join('\n'));
  await writeFile(path.join(artifactsDir, 'git-diff-stat.txt'), [trackedStat, untrackedStat].join('\n'));
}

async function writeUntrackedList(files) {
  await writeFile(
    path.join(artifactsDir, 'git-untracked.txt'),
    `$ git ls-files --others --exclude-standard\n\n${files.join('\n')}${files.length ? '\n' : ''}`,
  );
}

async function readUntrackedFiles() {
  const result = await run('git', ['ls-files', '--others', '--exclude-standard', '-z'], {
    cwd: worktree,
    allowFailure: true,
  });
  return result.stdout.split('\0').filter((file) => file && !isSensitiveArtifactPath(file));
}

async function untrackedDiffArtifact(files, diffArgs) {
  if (files.length === 0) return '# Untracked files\n\nNo untracked files.\n';

  const chunks = ['# Untracked files', ''];
  for (const file of files) {
    if (!(await isRegularFile(path.join(worktree, file)))) continue;
    const command = ['git', 'diff', '--no-index', ...diffArgs, '--', '/dev/null', file];
    const result = await run(command[0], command.slice(1), { cwd: worktree, allowFailure: true });
    chunks.push(`$ ${formatCommand(command)}`, '', result.stdout);
    if (result.stderr) chunks.push(`\n[stderr]\n${result.stderr}`);
    if (result.status !== 0 && result.status !== 1) chunks.push(`\n[exit ${result.status}]\n`);
    chunks.push('');
  }
  return chunks.join('\n');
}

async function commandArtifact(command) {
  const result = await run(command[0], command.slice(1), { cwd: worktree, allowFailure: true });
  let output = `$ ${formatCommand(command)}\n\n${result.stdout}`;
  if (result.stderr) output += `\n[stderr]\n${result.stderr}`;
  if (result.status !== 0) output += `\n[exit ${result.status}]\n`;
  if (!output.endsWith('\n')) output += '\n';
  return output;
}

async function writeCommand(fileName, command) {
  await writeFile(path.join(artifactsDir, fileName), await commandArtifact(command));
}

async function isRegularFile(file) {
  try {
    return (await stat(file)).isFile();
  } catch {
    return false;
  }
}

async function readCodexMetadata() {
  const traceFile = path.join(runDir, 'traces', 'agent.stdout.log');
  if (!(await exists(traceFile))) return null;

  let threadId = null;
  const contents = await readFile(traceFile, 'utf8');
  for (const line of contents.split('\n')) {
    if (!line.trim()) continue;
    try {
      const item = JSON.parse(line);
      if (item?.type === 'thread.started' && typeof item.thread_id === 'string') {
        threadId = item.thread_id;
        break;
      }
    } catch {
      // Trace files may contain non-JSON lines if an agent command is not JSONL.
    }
  }
  if (!threadId) return null;

  return {
    thread_id: threadId,
    session_log: await findCodexSessionLog(threadId),
  };
}

async function findCodexSessionLog(threadId) {
  const sessionsDir = path.join(process.env.HOME ?? '', '.codex', 'sessions');
  if (!(await exists(sessionsDir))) return null;

  const result = await run('find', [sessionsDir, '-type', 'f', '-name', `*${threadId}.jsonl`, '-print', '-quit'], {
    allowFailure: true,
  });
  const match = result.stdout.trim();
  return match || null;
}

function formatCommand(args) {
  return args.map(shellQuoteIfNeeded).join(' ');
}

function shellQuoteIfNeeded(value) {
  if (/^[A-Za-z0-9_./:=@+-]+$/.test(value)) return value;
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

function sensitivePathspecExcludes() {
  return [
    ':(exclude).env',
    ':(exclude).env.*',
    ':(exclude)**/.env',
    ':(exclude)**/.env.*',
  ];
}

function isSensitiveArtifactPath(file) {
  const normalized = file.split(path.sep).join('/');
  return normalized.split('/').some((part) => part === '.env' || part.startsWith('.env.'));
}

async function run(command, args, options = {}) {
  const child = spawn(command, args, {
    cwd: options.cwd ?? repoRoot,
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => {
    stdout += chunk;
  });
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
  });
  const status = await new Promise((resolve) => child.on('close', resolve));
  if (status !== 0 && !options.allowFailure) {
    throw new Error(`${command} ${args.join(' ')} exited ${status}: ${stderr || stdout}`);
  }
  return { status, stdout, stderr };
}
