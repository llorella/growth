import type { Command } from 'commander';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import type { ErrorObject } from 'ajv';
import { wrap, type RunCtx } from '../lib/runner.js';
import { requireInitialized } from '../lib/gating.js';
import { Store } from '../lib/store.js';
import { GrowthError } from '../lib/envelope.js';
import { paths } from '../lib/paths.js';
import { pull as pullEvents } from '../lib/pull.js';
import { listConnectors } from '../lib/connectors.js';
import { preflightReportSchema } from '../domain/schema.js';
import type { AgentPacketSummary, ExperimentEvent, GrowthRun } from '../domain/types.js';

const ajv = new (Ajv2020 as unknown as { new (opts: object): Ajv2020 })({
  allErrors: true,
  strict: false,
});
(addFormats as unknown as (a: Ajv2020) => void)(ajv);
const validatePreflightReport = ajv.compile(preflightReportSchema);

const DEFAULT_PROMPT = `You are acting as a first-time user of this product.

Use only the browser tool specified in your packet. Do not inspect source code,
localStorage, network logs, analytics dashboards, repository files, environment
variables, or implementation details. Do not modify files.

Open the provided URL. Complete onboarding as naturally as you can. Make your own
choices. If the product gives multiple plausible paths, choose what seems useful
to you. Stop when you believe onboarding is complete or when you are genuinely
stuck.

Return a structured report matching the provided schema.
`;

export function registerPreflight(program: Command, ctx: RunCtx): void {
  const preflight = program.command('preflight').description('Prepare, pull, and audit synthetic browser-agent preflights.');
  const commandPrefix = 'growth preflight';

  preflight
    .command('prepare <experiment_id>')
    .description('Prepare browser-agent packets without launching agents.')
    .option('--agents <n>', 'Number of agent packets.', (v) => parseInt(v, 10), 4)
    .option('--browser', 'Prepare browser URLs and browser-use policy.', false)
    .option('--app-url <url>', 'Application URL agents should open.', 'http://localhost:3000')
    .option('--force-variant <variant>', 'Force a variant in packet URLs for test mode.')
    .option('--no-balance-variants', 'Do not force round-robin variants in packet URLs.')
    .action(
      async (
        experimentId: string,
        opts: { agents: number; browser: boolean; appUrl: string; forceVariant?: string; balanceVariants: boolean },
      ) => {
        await wrap(`${commandPrefix} prepare`, ctx, async () => {
          await requireInitialized(ctx.getRoot());
          const store = new Store(ctx.getRoot());
          const exp = await store.getExperiment(experimentId);
          if (!exp) throw new GrowthError('not_found', `Experiment "${experimentId}" not found.`);
          if (opts.forceVariant && !exp.variants.some((variant) => variant.id === opts.forceVariant)) {
            throw new GrowthError('invalid_variant', `Variant "${opts.forceVariant}" is not part of ${experimentId}.`, {
              variants: exp.variants.map((variant) => variant.id),
            });
          }
          if (opts.agents < 1 || opts.agents > 50) {
            throw new GrowthError('invalid_agents', '--agents must be between 1 and 50.');
          }
          const p = paths(ctx.getRoot());
          const runId = `preflight_${new Date().toISOString().replace(/[-:.]/g, '').replace('T', 'T').slice(0, 15)}Z`;
          const runDir = path.join(p.runsDir, runId);
          const packetDir = path.join(runDir, 'agent-packets');
          const reportsDir = path.join(runDir, 'reports');
          await fs.mkdir(packetDir, { recursive: true });
          await fs.mkdir(reportsDir, { recursive: true });
          await fs.writeFile(path.join(runDir, 'batch-start.txt'), new Date().toISOString() + '\n');

          const agents: AgentPacketSummary[] = [];
          for (let i = 1; i <= opts.agents; i++) {
            const agentId = `${runId}_agent_${i}`;
            const variantId = packetVariant(exp.variants.map((variant) => variant.id), i - 1, opts);
            const url = buildAgentUrl(opts.appUrl, experimentId, agentId, variantId);
            const base = `agent-${i}`;
            const promptFile = path.join(packetDir, `${base}.prompt.txt`);
            const policyFile = path.join(packetDir, `${base}.policy.json`);
            const schemaFile = path.join(packetDir, `${base}.report.schema.json`);
            const urlFile = path.join(packetDir, `${base}.url.txt`);
            await fs.writeFile(promptFile, DEFAULT_PROMPT);
            await fs.writeFile(urlFile, url + '\n');
            await fs.writeFile(
              policyFile,
              JSON.stringify(
                {
                  browser: opts.browser,
                  synthetic_variant: variantId ?? null,
                  may_read_source: false,
                  may_read_env: false,
                  may_modify_files: false,
                  allowed_url: url,
                },
                null,
                2,
              ) + '\n',
            );
            await fs.writeFile(schemaFile, JSON.stringify(preflightReportSchema, null, 2) + '\n');
            agents.push({
              agent_id: agentId,
              browser: opts.browser,
              url_file: path.relative(ctx.getRoot(), urlFile),
              prompt_file: path.relative(ctx.getRoot(), promptFile),
              report_schema_file: path.relative(ctx.getRoot(), schemaFile),
              policy_file: path.relative(ctx.getRoot(), policyFile),
              variant_id: variantId,
            });
          }

          const warnings = [];
          if (opts.forceVariant) {
            warnings.push({
              code: 'FORCED_VARIANT_TEST_MODE',
              message: 'Packet URLs force one variant. Use this only for instrumentation testing.',
            });
          } else if (opts.balanceVariants !== false) {
            warnings.push({
              code: 'BALANCED_SYNTHETIC_VARIANTS',
              message:
                'Packet URLs force round-robin variants so synthetic traffic can exercise every branch. This is browser-agent test traffic only.',
            });
          }
          warnings.push({
            code: 'EVENT_WINDOW_START',
            message:
              'Only events emitted at or after this preflight prepare time are included by growth preflight pull. Earlier instrumentation-test events are intentionally excluded.',
          });

          const run: GrowthRun = {
            id: runId,
            type: 'preflight',
            experiment_id: experimentId,
            status: 'prepared',
            created_at: new Date().toISOString(),
            event_window: { after: new Date().toISOString() },
            agents,
            artifacts: {
              run_dir: path.relative(ctx.getRoot(), runDir),
              launch_manual: path.relative(ctx.getRoot(), path.join(runDir, 'launch.manual.md')),
            },
            warnings,
          };
          const eventWindowAfter = run.event_window?.after ?? run.created_at;
          await fs.writeFile(path.join(runDir, 'run.json'), JSON.stringify(run, null, 2) + '\n');
          await fs.writeFile(path.join(runDir, 'launch.manual.md'), launchManual(run));
          return {
            data: { run },
            humanText: `Prepared preflight ${runId} with ${agents.length} agent packet(s).`,
            warnings: run.warnings,
            nextSteps: [
              `Open ${path.relative(ctx.getRoot(), path.join(runDir, 'launch.manual.md'))}.`,
              `Events before ${eventWindowAfter} will not be included in preflight pulls.`,
              `Attach reports with growth preflight attach-report ${runId} --agent <n> --file <report.json> --json.`,
              `Complete with growth preflight complete ${runId} --json.`,
            ],
            next: {
              command: `growth preflight attach-report ${runId} --agent <n> --file <report.json> --json`,
              until: 'all prepared agent reports are attached',
            },
          };
        });
      },
    );

  preflight
    .command('show <run_id>')
    .description('Show a prepared preflight run.')
    .action(async (runId: string) => {
      await wrap(`${commandPrefix} show`, ctx, async () => {
        await requireInitialized(ctx.getRoot());
        const run = await readRun(ctx.getRoot(), runId);
        return { data: { run }, humanText: JSON.stringify(run, null, 2) };
      });
    });

  preflight
    .command('attach-report <run_id>')
    .description('Attach one agent report JSON to a run.')
    .requiredOption('--agent <n>', 'Agent number from the packet file names.', (v) => parseInt(v, 10))
    .requiredOption('--file <path>', 'Report JSON file.')
    .action(async (runId: string, opts: { agent: number; file: string }) => {
      await wrap(`${commandPrefix} attach-report`, ctx, async () => {
        await requireInitialized(ctx.getRoot());
        const run = await readRun(ctx.getRoot(), runId);
        const reportRaw = await fs.readFile(path.resolve(ctx.getRoot(), opts.file), 'utf8');
        const report = JSON.parse(reportRaw) as unknown;
        if (!run.agents?.[opts.agent - 1]) {
          throw new GrowthError('agent_not_found', `Agent ${opts.agent} is not part of ${runId}.`);
        }
        const valid = validatePreflightReport(report);
        if (!valid) {
          throw new GrowthError('invalid_preflight_report', 'Preflight report failed schema validation.', {
            errors: (validatePreflightReport.errors ?? []).map((e: ErrorObject) => ({
              path: e.instancePath || '/',
              message: e.message ?? '',
            })),
          });
        }
        const p = paths(ctx.getRoot());
        const target = path.join(p.runsDir, runId, 'reports', `agent-${opts.agent}.report.json`);
        await fs.mkdir(path.dirname(target), { recursive: true });
        await fs.writeFile(target, reportRaw.endsWith('\n') ? reportRaw : reportRaw + '\n');
        run.artifacts[`agent_${opts.agent}_report`] = path.relative(ctx.getRoot(), target);
        await writeRun(ctx.getRoot(), run);
        return {
          data: { run, report: path.relative(ctx.getRoot(), target) },
          humanText: `Attached report for agent ${opts.agent} to ${runId}.`,
          next: {
            command: `growth preflight complete ${runId} --json`,
            until: 'all agent reports are attached and the preflight window can be closed',
          },
        };
      });
    });

  preflight
    .command('pull <run_id>')
    .description('Pull events for a preflight run using its recorded event window.')
    .requiredOption('--source <name>', 'Connector source name, for example posthog.')
    .option('--before <iso>', 'Override upper bound timestamp; defaults to run window or now.')
    .option('--limit <n>', 'Per-event-name page size cap.', (v) => parseInt(v, 10))
    .action(async (runId: string, opts: { source: string; before?: string; limit?: number }) => {
      await wrap(`${commandPrefix} pull`, ctx, async () => {
        await requireInitialized(ctx.getRoot());
        const run = await readRun(ctx.getRoot(), runId);
        if (!run.experiment_id) {
          throw new GrowthError('run_missing_experiment', `Run "${runId}" is not tied to an experiment.`);
        }
        if (!run.event_window?.after) {
          throw new GrowthError('run_missing_window', `Run "${runId}" does not have an event window.`);
        }
        const before = opts.before ?? run.event_window.before ?? new Date().toISOString();
        const result = await pullEvents(ctx.getRoot(), {
          experimentId: run.experiment_id,
          source: opts.source,
          after: run.event_window.after,
          before,
          limit: opts.limit,
          runId,
          allowOverlap: ctx.assumeYes(),
        });
        run.artifacts[`pull_${opts.source}`] = result.pull_file;
        await writeRun(ctx.getRoot(), run);
        return {
          data: { run, pull: result },
          humanText: `Pulled ${run.experiment_id} for ${runId} from ${opts.source}.`,
          nextSteps: [`growth preflight audit ${runId} --json`],
          next: {
            command: `growth preflight audit ${runId} --json`,
            until: 'audit recommendation is ready_for_real_users or a concrete fix is identified',
          },
        };
      });
    });

  preflight
    .command('complete <run_id>')
    .description('Mark a preflight run as completed.')
    .action(async (runId: string) => {
      await wrap(`${commandPrefix} complete`, ctx, async () => {
        await requireInitialized(ctx.getRoot());
        const run = await readRun(ctx.getRoot(), runId);
        run.status = 'completed';
        run.completed_at = new Date().toISOString();
        run.event_window = { ...(run.event_window ?? { after: run.created_at }), before: run.completed_at };
        await writeRun(ctx.getRoot(), run);
        const connectors = await listConnectors(ctx.getRoot());
        const preferredSource = connectors.find((connector) => connector.source === 'local')?.source ?? connectors[0]?.source;
        return {
          data: { run },
          humanText: `Completed preflight ${runId}.`,
          nextSteps: run.experiment_id
            ? [
                `growth preflight audit ${runId} --markdown`,
                preferredSource
                  ? `growth preflight pull ${runId} --source ${preferredSource} --json`
                  : 'growth connector add local --events-file tmp/events.jsonl --json',
              ]
            : [],
          next: run.experiment_id
            ? {
                command: preferredSource
                  ? `growth preflight pull ${runId} --source ${preferredSource} --json`
                  : 'growth connector add local --events-file tmp/events.jsonl --json',
                until: preferredSource
                  ? 'events are pulled for the preflight run window'
                  : 'a connector is configured for preflight event pulls',
              }
            : undefined,
        };
      });
    });

  preflight
    .command('audit <run_id>')
    .description('Create a launch-readiness audit for a preflight run.')
    .option('--markdown', 'Print markdown instead of JSON data.')
    .action(async (runId: string, opts: { markdown?: boolean }) => {
      await wrap(`${commandPrefix} audit`, ctx, async () => {
        await requireInitialized(ctx.getRoot());
        const run = await readRun(ctx.getRoot(), runId);
        const audit = await auditPreflight(ctx.getRoot(), run);
        const markdown = auditMarkdown(run, audit);
        const auditFile = path.join(paths(ctx.getRoot()).runsDir, runId, 'audit.md');
        await fs.writeFile(auditFile, markdown);
        audit.audit_file = path.relative(ctx.getRoot(), auditFile);
        return {
          data: { run, audit, audit_file: audit.audit_file, markdown },
          humanText: opts.markdown ? markdown : `Wrote ${path.relative(ctx.getRoot(), auditFile)}.`,
          next: {
            command:
              audit.recommendation === 'ready_for_real_users'
                ? `growth analyze ${run.experiment_id ?? '<experiment_id>'} --segment real-users --json`
                : `growth preflight audit ${runId} --json`,
            until:
              audit.recommendation === 'ready_for_real_users'
                ? 'real-user launch and measurement are ready to begin'
                : `recommendation is not ${audit.recommendation}`,
          },
        };
      });
    });
}

function packetVariant(
  variantIds: string[],
  index: number,
  opts: { forceVariant?: string; balanceVariants: boolean },
): string | undefined {
  if (opts.forceVariant) return opts.forceVariant;
  if (opts.balanceVariants === false) return undefined;
  return variantIds[index % variantIds.length];
}

function buildAgentUrl(appUrl: string, experimentId: string, agentRunId: string, variantId?: string): string {
  const url = new URL(appUrl);
  url.searchParams.set('agent_generated', 'true');
  url.searchParams.set('agent_run_id', agentRunId);
  url.searchParams.set('experiment_id', experimentId);
  if (variantId) url.searchParams.set('variant', variantId);
  return url.toString();
}

async function readRun(root: string, runId: string): Promise<GrowthRun> {
  try {
    return JSON.parse(await fs.readFile(path.join(paths(root).runsDir, runId, 'run.json'), 'utf8')) as GrowthRun;
  } catch {
    throw new GrowthError('run_not_found', `Run "${runId}" not found.`);
  }
}

async function writeRun(root: string, run: GrowthRun): Promise<void> {
  await fs.writeFile(path.join(paths(root).runsDir, run.id, 'run.json'), JSON.stringify(run, null, 2) + '\n');
}

function launchManual(run: GrowthRun): string {
  return [
    `# ${run.id}`,
    '',
    `Experiment: ${run.experiment_id ?? '(none)'}`,
    '',
    'Launch each packet with a browser-capable agent. The agent may only use the URL, prompt, policy, and report schema in its packet.',
    '',
    ...(run.agents ?? []).map(
      (agent, i) =>
        `${i + 1}. ${agent.agent_id}\n   - URL: ${agent.url_file}\n   - Prompt: ${agent.prompt_file}\n   - Policy: ${agent.policy_file}\n   - Report schema: ${agent.report_schema_file}`,
    ),
    '',
  ].join('\n');
}

interface PreflightReportSummary {
  file: string;
  completed_onboarding: boolean;
  stop_reason: string;
  variant_observed?: string | null;
  conversion_observed?: boolean;
  activation_observed?: boolean;
  guardrail_issue_observed?: boolean;
  confusing_or_broken: string[];
  auth_or_payment_blockers: string[];
  internal_ui_visible: string[];
  missing_expected_events: string[];
  screenshot_or_trace_artifacts: string[];
}

type AuditRecommendation =
  | 'ready_for_real_users'
  | 'fix_instrumentation'
  | 'fix_variant_reachability'
  | 'fix_ux_blocker'
  | 'fix_auth_or_environment'
  | 'do_not_launch';

interface PreflightAudit {
  run_id: string;
  experiment_id?: string;
  recommendation: AuditRecommendation;
  checks: Array<{ id: string; status: 'pass' | 'warn' | 'fail'; message: string; evidence?: unknown }>;
  reports: PreflightReportSummary[];
  synthetic_only: true;
  audit_file: string;
}

async function auditPreflight(root: string, run: GrowthRun): Promise<PreflightAudit> {
  const store = new Store(root);
  const exp = run.experiment_id ? await store.getExperiment(run.experiment_id) : null;
  const reports = await readReports(root, run);
  const events = run.experiment_id ? filterEventsForPreflightRun(await store.readEvents(run.experiment_id), run) : [];
  const checks: PreflightAudit['checks'] = [];
  const expectedAgents = run.agents?.length ?? 0;
  const expectedVariants = new Set((run.agents ?? []).map((agent) => agent.variant_id).filter((v): v is string => !!v));
  if (expectedVariants.size === 0 && exp) {
    for (const variant of exp.variants) expectedVariants.add(variant.id);
  }
  const reportedVariants = new Set(reports.map((report) => report.variant_observed).filter((v): v is string => !!v));
  const eventVariants = new Set(events.map((event) => event.variant_id));
  const observedVariants = new Set([...reportedVariants, ...eventVariants]);
  const missingVariants = Array.from(expectedVariants).filter((variant) => !observedVariants.has(variant));
  checks.push({
    id: 'reports_attached',
    status: reports.length >= expectedAgents && expectedAgents > 0 ? 'pass' : 'fail',
    message: `Reports attached: ${reports.length} / ${expectedAgents}`,
    evidence: { attached: reports.length, expected: expectedAgents },
  });
  checks.push({
    id: 'variant_reachability',
    status: missingVariants.length === 0 ? 'pass' : 'fail',
    message:
      missingVariants.length === 0
        ? 'Every expected variant was reached.'
        : `Missing variant coverage: ${missingVariants.join(', ')}`,
    evidence: { expected: Array.from(expectedVariants), observed: Array.from(observedVariants), missing: missingVariants },
  });

  const requiredEvents = new Set<string>();
  if (exp) {
    for (const metric of exp.metrics) {
      requiredEvents.add(metric.event);
      if (metric.denominator_event) requiredEvents.add(metric.denominator_event);
    }
    for (const event of exp.instrumentation?.events ?? []) requiredEvents.add(event.event);
  }
  const eventNames = new Set(events.map((event) => event.event));
  const missingEvents = Array.from(requiredEvents).filter((event) => !eventNames.has(event));
  const reportedMissingEvents = reports.flatMap((report) => report.missing_expected_events);
  checks.push({
    id: 'required_events',
    status: missingEvents.length === 0 && reportedMissingEvents.length === 0 ? 'pass' : 'fail',
    message:
      missingEvents.length === 0 && reportedMissingEvents.length === 0
        ? 'Required events were observed.'
        : `Missing expected events: ${[...missingEvents, ...reportedMissingEvents].join(', ')}`,
    evidence: { required: Array.from(requiredEvents), observed: Array.from(eventNames), reported_missing: reportedMissingEvents },
  });

  const stuckReports = reports.filter((report) => report.stop_reason === 'stuck' || report.stop_reason === 'error');
  const confusing = reports.flatMap((report) => report.confusing_or_broken.map((note) => ({ file: report.file, note })));
  checks.push({
    id: 'ux_blockers',
    status: stuckReports.length === 0 && confusing.length === 0 ? 'pass' : 'fail',
    message:
      stuckReports.length === 0 && confusing.length === 0
        ? 'No UX blockers were reported.'
        : `${stuckReports.length} stuck/error report(s), ${confusing.length} confusing/broken note(s).`,
    evidence: { stuck_reports: stuckReports.map((report) => report.file), confusing },
  });

  const authBlockers = reports.flatMap((report) =>
    report.auth_or_payment_blockers.map((note) => ({ file: report.file, note })),
  );
  checks.push({
    id: 'auth_or_environment',
    status: authBlockers.length === 0 ? 'pass' : 'fail',
    message: authBlockers.length === 0 ? 'No auth/payment/environment blockers were reported.' : `${authBlockers.length} auth/payment blocker(s).`,
    evidence: authBlockers,
  });

  const internalUi = reports.flatMap((report) =>
    report.internal_ui_visible.map((note) => ({ file: report.file, note })),
  );
  checks.push({
    id: 'internal_ui_visible',
    status: internalUi.length === 0 ? 'pass' : 'fail',
    message: internalUi.length === 0 ? 'No internal UI was visible.' : `${internalUi.length} internal UI leak(s).`,
    evidence: internalUi,
  });

  const unlabeled = events.filter((event) => event.payload?.agent_generated !== true || !event.payload?.agent_run_id);
  checks.push({
    id: 'synthetic_labels',
    status: unlabeled.length === 0 ? 'pass' : 'fail',
    message: unlabeled.length === 0 ? 'Pulled events are labeled synthetic.' : `${unlabeled.length} pulled event(s) missing synthetic labels.`,
    evidence: { unlabeled: unlabeled.slice(0, 20).map(eventSummary) },
  });

  const recommendation = recommendationFor(checks);
  return {
    run_id: run.id,
    experiment_id: run.experiment_id,
    recommendation,
    checks,
    reports,
    synthetic_only: true,
    audit_file: '',
  };
}

function filterEventsForPreflightRun(events: ExperimentEvent[], run: GrowthRun): ExperimentEvent[] {
  const after = run.event_window?.after ? Date.parse(run.event_window.after) : Number.NEGATIVE_INFINITY;
  const before = run.event_window?.before ? Date.parse(run.event_window.before) : Number.POSITIVE_INFINITY;
  const agentIds = new Set((run.agents ?? []).map((agent) => agent.agent_id).filter((id): id is string => !!id));
  return events.filter((event) => {
    const ts = Date.parse(event.timestamp);
    if (Number.isFinite(ts) && (ts < after || ts > before)) return false;
    if (agentIds.size === 0) return true;
    const agentRunId = event.payload?.agent_run_id;
    return typeof agentRunId !== 'string' || agentIds.has(agentRunId);
  });
}

function auditMarkdown(run: GrowthRun, audit: PreflightAudit): string {
  const reports = audit.reports;
  const reportsAttached = audit.checks.find((check) => check.id === 'reports_attached')?.message ?? '';
  const variantReachability = audit.checks.find((check) => check.id === 'variant_reachability')?.message ?? '';
  const requiredEvents = audit.checks.find((check) => check.id === 'required_events')?.message ?? '';
  const stopReasons = countBy(reports.map((report) => report.stop_reason || '(missing)'));
  const variants = countBy(reports.map((report) => report.variant_observed || '(not reported)'));
  const completed = reports.filter((report) => report.completed_onboarding).length;
  const conversions = reports.filter((report) => report.conversion_observed).length;
  const activations = reports.filter((report) => report.activation_observed).length;
  const guardrails = reports.filter((report) => report.guardrail_issue_observed).length;
  const confusingNotes = reports.flatMap((report) =>
    report.confusing_or_broken.map((note) => ({ file: report.file, note })),
  );
  const internalUi = reports.flatMap((report) =>
    report.internal_ui_visible.map((note) => ({ file: report.file, note })),
  );
  return [
    `# growth Audit: ${run.id}`,
    '',
    `Type: ${run.type}`,
    `Status: ${run.status}`,
    `Experiment: ${run.experiment_id ?? '(none)'}`,
    `Created: ${run.created_at}`,
    `Completed: ${run.completed_at ?? '(not completed)'}`,
    `Recommendation: ${audit.recommendation}`,
    '',
    'Synthetic browser-agent traffic validates instrumentation and UX only. It is not real-user evidence and must not be used to ship a treatment.',
    '',
    '## Launch Checks',
    '',
    ...audit.checks.map((check) => `- ${check.status.toUpperCase()} ${check.id}: ${check.message}`),
    '',
    '## Agent Reports',
    '',
    reportsAttached,
    variantReachability,
    requiredEvents,
    `Completed onboarding: ${completed} / ${reports.length}`,
    `Conversion observed: ${conversions} / ${reports.length}`,
    `Activation observed: ${activations} / ${reports.length}`,
    `Guardrail issues observed: ${guardrails} / ${reports.length}`,
    `Confusing or broken notes: ${confusingNotes.length}`,
    `Internal UI leaks: ${internalUi.length}`,
    '',
    '## Stop Reasons',
    '',
    ...formatCounts(stopReasons),
    '',
    '## Variants Observed',
    '',
    ...formatCounts(variants),
    '',
    ...(confusingNotes.length
      ? [
          '## Confusing Or Broken',
          '',
          ...confusingNotes.map((item) => `- ${item.file}: ${item.note}`),
          '',
        ]
      : []),
    ...(internalUi.length
      ? [
          '## Internal UI Visible',
          '',
          ...internalUi.map((item) => `- ${item.file}: ${item.note}`),
          '',
        ]
      : []),
    '## Artifacts',
    '',
    ...Object.entries(run.artifacts).map(([key, value]) => `- ${key}: ${value}`),
    '',
  ].join('\n');
}

function recommendationFor(checks: PreflightAudit['checks']): AuditRecommendation {
  const failed = new Set(checks.filter((check) => check.status === 'fail').map((check) => check.id));
  if (failed.has('internal_ui_visible') || failed.has('synthetic_labels')) return 'do_not_launch';
  if (failed.has('required_events')) return 'fix_instrumentation';
  if (failed.has('variant_reachability') || failed.has('reports_attached')) return 'fix_variant_reachability';
  if (failed.has('auth_or_environment')) return 'fix_auth_or_environment';
  if (failed.has('ux_blockers')) return 'fix_ux_blocker';
  return 'ready_for_real_users';
}

function eventSummary(event: ExperimentEvent): Record<string, unknown> {
  return {
    event: event.event,
    user_id: event.user_id,
    variant_id: event.variant_id,
    timestamp: event.timestamp,
  };
}

async function readReports(root: string, run: GrowthRun): Promise<PreflightReportSummary[]> {
  const reportFiles = new Set<string>();
  for (const [key, value] of Object.entries(run.artifacts)) {
    if (/^agent_\d+_report$/.test(key)) reportFiles.add(path.resolve(root, value));
  }
  const reportsDir = path.join(paths(root).runsDir, run.id, 'reports');
  try {
    for (const file of await fs.readdir(reportsDir)) {
      if (file.endsWith('.report.json')) reportFiles.add(path.join(reportsDir, file));
    }
  } catch {
    // no reports yet
  }

  const reports: PreflightReportSummary[] = [];
  for (const file of Array.from(reportFiles).sort()) {
    try {
      const parsed = JSON.parse(await fs.readFile(file, 'utf8')) as PreflightReportSummary;
      reports.push({
        ...parsed,
        file: path.relative(root, file),
        confusing_or_broken: Array.isArray(parsed.confusing_or_broken) ? parsed.confusing_or_broken : [],
        auth_or_payment_blockers: Array.isArray(parsed.auth_or_payment_blockers) ? parsed.auth_or_payment_blockers : [],
        internal_ui_visible: Array.isArray(parsed.internal_ui_visible) ? parsed.internal_ui_visible : [],
        missing_expected_events: Array.isArray(parsed.missing_expected_events) ? parsed.missing_expected_events : [],
        screenshot_or_trace_artifacts: Array.isArray(parsed.screenshot_or_trace_artifacts)
          ? parsed.screenshot_or_trace_artifacts
          : [],
      });
    } catch {
      // ignore malformed attached reports; attach-report enforces schema for canonical reports
    }
  }
  return reports;
}

function countBy(values: string[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const value of values) out[value] = (out[value] ?? 0) + 1;
  return out;
}

function formatCounts(counts: Record<string, number>): string[] {
  const entries = Object.entries(counts).sort(([a], [b]) => a.localeCompare(b));
  if (!entries.length) return ['- none'];
  return entries.map(([key, count]) => `- ${key}: ${count}`);
}
