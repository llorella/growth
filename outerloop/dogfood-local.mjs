#!/usr/bin/env node
import { writeFileSync } from 'node:fs';
import { cp, mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const opts = parseArgs(process.argv.slice(2));
const fixturesRoot = path.resolve(repoRoot, opts.fixturesDir ?? 'examples/fixtures');
const fixtureFilter = opts.fixture ? new Set(String(opts.fixture).split(',').filter(Boolean)) : null;
const iterations = Number.parseInt(opts.iterations ?? '2', 10);
const runsDir = path.resolve(repoRoot, opts.runsDir ?? `outerloop/runs/local-dogfood-${timestampId()}`);
const cli = path.join(repoRoot, 'dist', 'index.js');

if (!Number.isInteger(iterations) || iterations < 1) {
  throw new Error('--iterations must be a positive integer.');
}

await main();

async function main() {
  const fixtures = await listFixtures();
  if (!fixtures.length) throw new Error(`No fixtures found under ${fixturesRoot}.`);
  await mkdir(runsDir, { recursive: true });

  const runs = [];
  for (let iteration = 1; iteration <= iterations; iteration++) {
    for (const fixture of fixtures) {
      runs.push(await runFixture(fixture, iteration));
    }
  }

  const summary = {
    pass: runs.every((run) => run.pass),
    runs_dir: path.relative(repoRoot, runsDir),
    iterations,
    fixtures: fixtures.map((fixture) => fixture.name),
    runs,
    generated_at: new Date().toISOString(),
  };
  await writeFile(path.join(runsDir, 'summary.json'), JSON.stringify(summary, null, 2) + '\n');
  process.stdout.write(JSON.stringify(summary, null, 2) + '\n');
  if (!summary.pass) process.exitCode = 1;
}

async function listFixtures() {
  const entries = await readdir(fixturesRoot, { withFileTypes: true });
  const fixtures = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (fixtureFilter && !fixtureFilter.has(entry.name)) continue;
    const dir = path.join(fixturesRoot, entry.name);
    const configFile = path.join(dir, 'dogfood.json');
    try {
      const config = JSON.parse(await readFile(configFile, 'utf8'));
      fixtures.push({ name: entry.name, dir, config });
    } catch (err) {
      throw new Error(`Invalid fixture config ${configFile}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return fixtures.sort((a, b) => a.name.localeCompare(b.name));
}

async function runFixture(fixture, iteration) {
  const runId = `${fixture.name}-iter-${iteration}`;
  const runDir = path.join(runsDir, runId);
  const appDir = path.join(runDir, 'app');
  const tracesDir = path.join(runDir, 'traces');
  const artifactsDir = path.join(runDir, 'artifacts');
  await rm(runDir, { recursive: true, force: true });
  await mkdir(tracesDir, { recursive: true });
  await mkdir(artifactsDir, { recursive: true });
  await copyFixtureApp(fixture.dir, appDir);

  const commands = [];
  const run = (args, extra = {}) => {
    const result = runGrowth(appDir, args, tracesDir, commands, extra);
    assertEnvelope(result, args);
    return result;
  };

  const inspection = await inspectApp(appDir);
  await writeJson(path.join(artifactsDir, 'inspection.json'), inspection);

  const preStatus = run(['status', '--json']);
  assertNext(preStatus, /growth init --json/, 'pre-init status');
  const init = run(['init', '--json']);
  assertNext(init, /growth status --json|growth schema experiment --json/, 'init');
  const status = run(['status', '--json']);
  assertNext(status, /growth schema experiment --json/, 'empty status');
  const context = run(['llm-context', '--json']);
  assertNext(context, /growth schema experiment --json/, 'llm-context without experiments');
  const schema = run(['schema', 'experiment', '--json']);
  if (schema.data?.schema?.properties?.preflight === undefined && schema.data?.properties?.preflight === undefined) {
    throw new Error(`${runId}: experiment schema did not expose preflight scenarios.`);
  }

  run(['connector', 'add', 'local', '--events-file', 'tmp/events.jsonl', '--json']);
  const specFile = path.join(artifactsDir, 'experiment-spec.json');
  const spec = fixture.config.experiment;
  await writeJson(specFile, spec);
  const create = run([
    'experiment',
    'create',
    spec.id,
    '--from-file',
    specFile,
    '--json',
  ]);
  assertNext(create, new RegExp(`growth instrumentation plan ${escapeRegExp(spec.id)} --json`), 'experiment create');

  const plan = run(['instrumentation', 'plan', spec.id, '--json']);
  assertIncludes(plan.data?.preflight_query_params?.map((param) => param.name), ['agent_generated', 'agent_run_id', 'experiment_id', 'variant'], `${runId}: plan preflight query params`);
  assertNext(plan, new RegExp(`growth instrumentation verify ${escapeRegExp(spec.id)} --json|growth preflight prepare ${escapeRegExp(spec.id)}`), 'instrumentation plan');

  const localEventsFile = path.join(appDir, 'tmp', 'events.jsonl');
  await mkdir(path.dirname(localEventsFile), { recursive: true });
  await writeFile(localEventsFile, buildGeneralEvents(spec, fixture.config.local_event_sets ?? defaultEventSets(spec)), 'utf8');

  const verify = run(['instrumentation', 'verify', spec.id, '--events-file', 'tmp/events.jsonl', '--json']);
  if (verify.data?.ok !== true) {
    throw new Error(`${runId}: instrumentation verify did not pass.`);
  }
  assertNext(verify, new RegExp(`growth preflight prepare ${escapeRegExp(spec.id)}`), 'instrumentation verify');

  const dryRun = run(['preflight', 'dry-run', spec.id, '--events-file', 'tmp/events.jsonl', '--json']);
  if (dryRun.data?.audit?.recommendation !== 'ready_for_provider_preflight') {
    throw new Error(`${runId}: dry-run recommendation was ${dryRun.data?.audit?.recommendation}.`);
  }
  assertNext(dryRun, new RegExp(`growth preflight prepare ${escapeRegExp(spec.id)}`), 'preflight dry-run');

  const prepared = run([
    'preflight',
    'prepare',
    spec.id,
    '--agents',
    String(fixture.config.agents ?? 4),
    '--browser',
    '--json',
  ]);
  assertNext(prepared, /growth preflight complete-local .* --events-file <events\.jsonl> --json/, 'preflight prepare');
  const preflightRun = prepared.data.run;
  await writeFile(localEventsFile, buildPreflightEvents(spec, preflightRun, fixture.config.preflight_event_sets ?? defaultEventSets(spec)), 'utf8');
  const attachedReports = [];
  for (const [index, agent] of (preflightRun.agents ?? []).entries()) {
    const reportFile = path.join(artifactsDir, `agent-${index + 1}.report.json`);
    await writeJson(reportFile, buildReport(spec, agent));
    const attached = run([
      'preflight',
      'attach-report',
      preflightRun.id,
      '--agent',
      String(index + 1),
      '--file',
      reportFile,
      '--json',
    ]);
    assertNext(attached, new RegExp(`growth preflight complete ${escapeRegExp(preflightRun.id)} --json`), `attach report ${index + 1}`);
    attachedReports.push(attached);
  }

  const complete = run(['preflight', 'complete', preflightRun.id, '--json']);
  assertNext(complete, new RegExp(`growth preflight pull ${escapeRegExp(preflightRun.id)} --source local --json`), 'preflight complete');
  const pull = run(['--yes', 'preflight', 'pull', preflightRun.id, '--source', 'local', '--json']);
  assertNext(pull, new RegExp(`growth preflight audit ${escapeRegExp(preflightRun.id)} --json`), 'preflight pull');
  if ((pull.data?.pull?.emitted ?? 0) < expectedEventCount(preflightRun, spec)) {
    throw new Error(`${runId}: preflight pull emitted too few events.`);
  }

  const audit = run(['preflight', 'audit', preflightRun.id, '--json']);
  if (audit.data?.audit?.recommendation !== 'ready_for_provider_preflight') {
    throw new Error(`${runId}: final audit recommendation was ${audit.data?.audit?.recommendation}.`);
  }
  assertNext(audit, /growth connector import stripe-projects --json|growth preflight pull .* --source [^ ]+ --json/, 'preflight audit');

  const checklist = dogfoodChecklist({
    fixture,
    inspection,
    preStatus,
    init,
    status,
    context,
    schema,
    create,
    plan,
    verify,
    dryRun,
    prepared,
    attachedReports,
    complete,
    pull,
    audit,
  });
  await writeJson(path.join(artifactsDir, 'checklist.json'), checklist);
  await writeJson(path.join(runDir, 'commands.json'), commands);

  return {
    id: runId,
    fixture: fixture.name,
    iteration,
    pass: checklist.every((item) => item.ok),
    app_dir: path.relative(repoRoot, appDir),
    audit_file: audit.data.audit_file,
    recommendation: audit.data.audit.recommendation,
    commands: commands.length,
  };
}

async function copyFixtureApp(from, to) {
  await mkdir(to, { recursive: true });
  await cp(from, to, {
    recursive: true,
    filter: (source) => {
      const base = path.basename(source);
      return !['dogfood.json', 'node_modules', '.growth', 'tmp', 'dist', 'build', '.next'].includes(base);
    },
  });
}

async function inspectApp(root) {
  const files = await walk(root);
  const packageJson = await readJsonIfExists(path.join(root, 'package.json'));
  const readme = await readTextIfExists(path.join(root, 'README.md'));
  const sourceSnippets = [];
  for (const file of files.filter((item) => /\.(tsx?|jsx?|md)$/.test(item)).slice(0, 12)) {
    const text = await readTextIfExists(path.join(root, file));
    sourceSnippets.push({
      file,
      signals: signalWords(text),
    });
  }
  return {
    files,
    package: {
      name: packageJson?.name,
      scripts: packageJson?.scripts ?? {},
      dependencies: Object.keys(packageJson?.dependencies ?? {}).sort(),
      devDependencies: Object.keys(packageJson?.devDependencies ?? {}).sort(),
    },
    readme_title: readme.split('\n').find((line) => line.startsWith('# '))?.replace(/^#\s+/, '') ?? null,
    product_signals: unique(sourceSnippets.flatMap((snippet) => snippet.signals)),
    source_snippets: sourceSnippets,
  };
}

async function walk(root, rel = '') {
  const dir = path.join(root, rel);
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (['.git', 'node_modules', '.growth', 'tmp'].includes(entry.name)) continue;
    const childRel = rel ? `${rel}/${entry.name}` : entry.name;
    const full = path.join(root, childRel);
    if (entry.isDirectory()) out.push(...(await walk(root, childRel)));
    else if (entry.isFile()) {
      const s = await stat(full);
      out.push(childRel);
      if (s.size > 250_000) continue;
    }
  }
  return out.sort();
}

function runGrowth(root, args, tracesDir, commands, extra = {}) {
  const index = String(commands.length + 1).padStart(2, '0');
  const result = spawnSync(process.execPath, [cli, '--root', root, ...args], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: { ...process.env, ...(extra.env ?? {}) },
  });
  const parsed = parseJson(result.stdout);
  const record = {
    index: Number(index),
    args,
    status: result.status,
    ok: parsed?.ok ?? false,
    command: parsed?.command,
    next: parsed?._next,
    next_steps: parsed?.next_steps ?? [],
  };
  commands.push(record);
  const base = `${index}-${safeTraceName(args.filter((arg) => !arg.startsWith('--')).join('-') || 'root')}`;
  writeFileSync(path.join(tracesDir, `${base}.stdout.json`), result.stdout || '');
  writeFileSync(path.join(tracesDir, `${base}.stderr.log`), result.stderr || '');
  if (result.status !== 0) {
    throw new Error(`growth ${args.join(' ')} exited ${result.status}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  }
  if (!parsed) throw new Error(`growth ${args.join(' ')} did not print JSON.`);
  return parsed;
}

function assertEnvelope(result, args) {
  if (result.ok !== true) throw new Error(`growth ${args.join(' ')} returned ok=false.`);
  if (!result.command || !result.meta) throw new Error(`growth ${args.join(' ')} returned an incomplete envelope.`);
}

function assertNext(envelope, pattern, label) {
  const command = envelope._next?.command ?? '';
  if (!pattern.test(command)) {
    throw new Error(`${label}: next command "${command}" did not match ${pattern}.`);
  }
}

function assertIncludes(actual, expected, label) {
  const set = new Set(actual ?? []);
  const missing = expected.filter((item) => !set.has(item));
  if (missing.length) throw new Error(`${label} missing ${missing.join(', ')}.`);
}

function dogfoodChecklist(items) {
  const checks = [
    ['app_inspection_artifact', items.inspection.files.length > 0, { files: items.inspection.files.length }],
    ['preinit_guides_to_init', /growth init --json/.test(items.preStatus._next?.command ?? '')],
    ['init_writes_agent_skill', (items.init.data?.wrote?.skills ?? []).some((file) => file.endsWith('/SKILL.md') || file.endsWith('\\SKILL.md')), {
      wrote: items.init.data?.wrote?.skills ?? [],
    }],
    ['status_guides_to_schema', /growth schema experiment --json/.test(items.status._next?.command ?? '')],
    ['llm_context_guides_to_schema', /growth schema experiment --json/.test(items.context._next?.command ?? '')],
    ['schema_exposes_preflight_report', !!(items.context.data?.schemas?.preflight_report)],
    ['experiment_schema_exposes_preflight_scenarios', !!items.schema.data?.schema?.properties?.preflight],
    ['experiment_spec_created', items.create.data?.experiment?.id === items.fixture.config.experiment.id],
    ['experiment_guides_to_instrumentation_plan', /growth instrumentation plan/.test(items.create._next?.command ?? '')],
    ['plan_exposes_contract_and_preflight_params', !!items.plan.data?.required_contract && (items.plan.data?.preflight_query_params ?? []).length >= 4],
    ['plan_prompt_packet_guides_agent', /growth instrumentation verify/.test((items.plan.data?.prompt_packet?.commands_after_editing ?? []).join('\n'))],
    ['instrumentation_verify_passes', items.verify.data?.ok === true],
    ['verify_guides_to_preflight_prepare', /growth preflight prepare/.test(items.verify._next?.command ?? '')],
    ['dry_run_ready_for_provider_preflight', items.dryRun.data?.audit?.recommendation === 'ready_for_provider_preflight'],
    ['prepare_writes_agent_packets', (items.prepared.data?.run?.agents ?? []).length > 0],
    ['prepare_guides_to_completion', /growth preflight complete-local/.test(items.prepared._next?.command ?? '')],
    ['reports_attached', (items.attachedReports ?? []).length === (items.prepared.data?.run?.agents ?? []).length],
    ['complete_guides_to_pull', /growth preflight pull/.test(items.complete._next?.command ?? '')],
    ['pull_guides_to_audit', /growth preflight audit/.test(items.pull._next?.command ?? '')],
    ['audit_ready_for_provider_preflight', items.audit.data?.audit?.recommendation === 'ready_for_provider_preflight'],
    ['audit_guides_to_provider_validation', /growth connector import stripe-projects --json|growth preflight pull .* --source [^ ]+ --json/.test(items.audit._next?.command ?? '')],
  ];
  return checks.map(([id, ok, evidence]) => ({ id, ok: Boolean(ok), ...(evidence ? { evidence } : {}) }));
}

function buildGeneralEvents(spec, eventSets) {
  const lines = [];
  let i = 0;
  for (const variant of spec.variants.map((variant) => variant.id)) {
    for (const event of eventSets[variant] ?? requiredEvents(spec)) {
      lines.push(eventLine(spec.id, event, variant, `dogfood-${variant}`, `dogfood-general-${i++}`, new Date().toISOString()));
    }
  }
  return lines.join('\n') + '\n';
}

function buildPreflightEvents(spec, run, eventSets) {
  const after = Date.parse(run.event_window?.after ?? new Date().toISOString());
  const lines = [];
  let i = 0;
  for (const agent of run.agents ?? []) {
    const variant = agent.variant_id ?? spec.variants[0].id;
    for (const event of eventSets[variant] ?? requiredEvents(spec)) {
      const ts = new Date(after + 10 + i).toISOString();
      lines.push(eventLine(spec.id, event, variant, agent.agent_id, `dogfood-preflight-${agent.agent_id}-${event}-${i++}`, ts));
    }
  }
  return lines.join('\n') + '\n';
}

function buildReport(spec, agent) {
  const primaryEvents = unique(
    (spec.metrics ?? [])
      .filter((metric) => metric.role === 'primary')
      .flatMap((metric) => [metric.denominator_event, metric.event].filter(Boolean)),
  );
  return {
    primary_goal_observed: true,
    stopped_at_url: 'http://localhost:5173/dogfood-complete',
    stop_reason: 'completed',
    path_taken: ['opened packet URL', 'followed fixture scenario', 'reached primary goal'],
    variant_observed: agent.variant_id ?? null,
    primary_metric_events_observed: primaryEvents,
    guardrail_observed: false,
    confusing_or_broken: [],
    blockers: [],
    internal_ui_visible: [],
    missing_expected_events: [],
    screenshot_or_trace_artifacts: [],
  };
}

function eventLine(experimentId, event, variant, agentRunId, eventId, timestamp) {
  return JSON.stringify({
    event,
    properties: {
      event_id: eventId,
      experiment_id: experimentId,
      variant_id: variant,
      user_id: `user-${agentRunId}`,
      anonymous_id: `anon-${agentRunId}`,
      session_id: `session-${agentRunId}`,
      timestamp,
      agent_generated: true,
      agent_run_id: agentRunId,
    },
  });
}

function expectedEventCount(run, spec) {
  return (run.agents?.length ?? 0) * requiredEvents(spec).length;
}

function defaultEventSets(spec) {
  return Object.fromEntries(spec.variants.map((variant) => [variant.id, requiredEvents(spec)]));
}

function requiredEvents(spec) {
  const out = new Set();
  for (const metric of spec.metrics ?? []) {
    out.add(metric.event);
    if (metric.denominator_event) out.add(metric.denominator_event);
  }
  for (const event of spec.instrumentation?.events ?? []) out.add(event.event);
  return Array.from(out).sort();
}

function signalWords(text) {
  const words = ['onboarding', 'activation', 'pricing', 'checkout', 'billing', 'report', 'workspace', 'settings', 'support', 'upgrade', 'trial'];
  return words.filter((word) => new RegExp(`\\b${word}\\b`, 'i').test(text));
}

async function readTextIfExists(file) {
  try {
    return await readFile(file, 'utf8');
  } catch {
    return '';
  }
}

async function readJsonIfExists(file) {
  const text = await readTextIfExists(file);
  if (!text) return null;
  return JSON.parse(text);
}

async function writeJson(file, value) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(value, null, 2) + '\n');
}

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function unique(values) {
  return Array.from(new Set(values)).sort();
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function safeTraceName(value) {
  return value.replace(/[^a-zA-Z0-9_.-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 120) || 'command';
}

function timestampId() {
  return new Date().toISOString().replace(/[-:.]/g, '').slice(0, 15) + 'Z';
}

function parseArgs(args) {
  const out = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (!arg.startsWith('--')) throw new Error(`Unexpected argument: ${arg}`);
    const key = arg.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    const value = args[i + 1];
    if (!value || value.startsWith('--')) {
      out[key] = 'true';
      continue;
    }
    out[key] = value;
    i++;
  }
  return out;
}
