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
import { detectFramework } from '../lib/framework.js';
import { resolveAppUrl } from '../lib/app-url.js';
import { pull as pullEvents } from '../lib/pull.js';
import { listConnectors, mapEvent, defaultLocalConnector } from '../lib/connectors.js';
import { preflightReportSchema } from '../domain/schema.js';
import type { AgentPacketSummary, Experiment, ExperimentEvent, GrowthRun } from '../domain/types.js';

const ajv = new (Ajv2020 as unknown as { new (opts: object): Ajv2020 })({
  allErrors: true,
  strict: false,
});
(addFormats as unknown as (a: Ajv2020) => void)(ajv);
const validatePreflightReport = ajv.compile(preflightReportSchema);

const BASE_PACKET_PROMPT = `You are acting as a realistic user of this product.

Use only the browser tool specified in your packet. Do not inspect source code,
localStorage, network logs, analytics dashboards, repository files, environment
variables, or implementation details. Do not modify files.

Open the provided URL. Follow the scenario in this packet. Make your own choices
where the product gives multiple plausible paths. Stop when the scenario is
complete or when you are genuinely stuck.

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
    .option('--app-url <url>', 'Application URL agents should open.')
    .option('--base-url <url>', 'Alias for --app-url.')
    .option('--force-variant <variant>', 'Force a variant in packet URLs for test mode.')
    .option('--no-balance-variants', 'Do not force round-robin variants in packet URLs.')
    .action(
      async (
        experimentId: string,
        opts: {
          agents: number;
          browser: boolean;
          appUrl?: string;
          baseUrl?: string;
          forceVariant?: string;
          balanceVariants: boolean;
        },
      ) => {
        await wrap(`${commandPrefix} prepare`, ctx, async () => {
          await requireInitialized(ctx.getRoot());
          if (opts.appUrl && opts.baseUrl && opts.appUrl !== opts.baseUrl) {
            throw new GrowthError('conflicting_app_urls', '--app-url and --base-url were both provided with different values.');
          }
          const store = new Store(ctx.getRoot());
          const exp = await store.getExperiment(experimentId);
          if (!exp) throw new GrowthError('not_found', `Experiment "${experimentId}" not found.`);
          const framework = await detectFramework(ctx.getRoot());
          const appUrl = await resolveAppUrl(ctx.getRoot(), framework, opts.appUrl ?? opts.baseUrl);
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
            const scenario = packetScenario(exp, i - 1);
            const url = buildAgentUrl(appUrl, experimentId, agentId, variantId);
            const base = `agent-${i}`;
            const promptFile = path.join(packetDir, `${base}.prompt.txt`);
            const policyFile = path.join(packetDir, `${base}.policy.json`);
            const schemaFile = path.join(packetDir, `${base}.report.schema.json`);
            const urlFile = path.join(packetDir, `${base}.url.txt`);
            await fs.writeFile(promptFile, packetPrompt(exp, scenario));
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
                  scenario,
                  expected_events: expectedEvents(exp),
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
          if (!opts.appUrl && !opts.baseUrl) {
            warnings.push({
              code: 'APP_URL_RESOLVED',
              message: `Using ${appUrl} for packet URLs. Override with --app-url or --base-url when your dev server uses a different URL.`,
            });
          }

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
            data: { run, run_id: run.id, app_url: appUrl, framework_hint: { detected: framework, advisory_only: true } },
            humanText: `Prepared preflight ${runId} with ${agents.length} agent packet(s).`,
            warnings: run.warnings,
            nextSteps: [
              `Packet app URL: ${appUrl}. Override future runs with --app-url or --base-url.`,
              `Open ${path.relative(ctx.getRoot(), path.join(runDir, 'launch.manual.md'))}.`,
              `Events before ${eventWindowAfter} will not be included in preflight pulls.`,
              `If browser execution writes local JSONL, complete in one step with growth preflight complete-local ${runId} --events-file <events.jsonl> --json.`,
              `Attach reports with growth preflight attach-report ${runId} --agent <n> --file <report.json> --json.`,
              `Complete with growth preflight complete ${runId} --json.`,
            ],
            next: {
              command: `growth preflight complete-local ${runId} --events-file <events.jsonl> --json`,
              until: 'synthetic browser events are attached and launch-readiness audit is written',
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
        const agent = run.agents[opts.agent - 1];
        return {
          data: {
            status: 'attached',
            run,
            agent_number: opts.agent,
            agent_id: agent?.agent_id,
            report_path: path.relative(ctx.getRoot(), target),
            report: path.relative(ctx.getRoot(), target),
            schema_validation: 'ok',
            report_summary: summarizeReport(report as unknown as PreflightReportSummary),
          },
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
            until: 'audit recommendation distinguishes provider-backed readiness from local-only preflight readiness',
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
    .command('complete-local <run_id>')
    .description('Complete and audit a prepared preflight from local app-emitted JSONL events.')
    .requiredOption('--events-file <path>', 'Local JSONL file containing app-emitted synthetic preflight events.')
    .option('--reports-dir <path>', 'Optional directory of preflight report JSON files.')
    .option('--markdown', 'Print markdown instead of JSON data.')
    .action(async (runId: string, opts: { eventsFile: string; reportsDir?: string; markdown?: boolean }) => {
      await wrap(`${commandPrefix} complete-local`, ctx, async () => {
        await requireInitialized(ctx.getRoot());
        const run = await readRun(ctx.getRoot(), runId);
        if (!run.experiment_id) {
          throw new GrowthError('run_missing_experiment', `Run "${runId}" is not tied to an experiment.`);
        }
        const store = new Store(ctx.getRoot());
        const exp = await store.getExperiment(run.experiment_id);
        if (!exp) throw new GrowthError('not_found', `Experiment "${run.experiment_id}" not found.`);
        const events = await readLocalEventsAsExperimentEvents(ctx.getRoot(), opts.eventsFile, exp);
        const reports = opts.reportsDir
          ? await readReportsFromDir(ctx.getRoot(), opts.reportsDir)
          : synthesizeReportsFromEvents(run, exp, events);
        run.status = 'completed';
        run.completed_at = new Date().toISOString();
        run.event_window = { ...(run.event_window ?? { after: run.created_at }), before: run.completed_at };
        run.artifacts.events_file = path.relative(ctx.getRoot(), path.resolve(ctx.getRoot(), opts.eventsFile));
        if (opts.reportsDir) {
          run.artifacts.reports_dir = path.relative(ctx.getRoot(), path.resolve(ctx.getRoot(), opts.reportsDir));
        } else {
          run.artifacts.reports_source = 'synthesized_from_events';
        }
        run.warnings = [
          ...(run.warnings ?? []),
          {
            code: 'LOCAL_PREFLIGHT_EVENTS',
            message:
              'This audit used local app-emitted synthetic events instead of a provider pull. Use provider-backed pull when validating ingestion, dashboards, or warehouse queries.',
          },
        ];
        await writeRun(ctx.getRoot(), run);
        const audit = await auditPreflight(ctx.getRoot(), run, { eventsOverride: events, reportsOverride: reports });
        const markdown = auditMarkdown(run, audit);
        const auditFile = path.join(paths(ctx.getRoot()).runsDir, runId, 'audit.md');
        await fs.writeFile(auditFile, markdown);
        audit.audit_file = path.relative(ctx.getRoot(), auditFile);
        const next = await nextAfterAudit(ctx.getRoot(), run, audit);
        return {
          data: { run, audit, audit_file: audit.audit_file, markdown },
          warnings: run.warnings,
          humanText: opts.markdown ? markdown : `Completed ${runId} and wrote ${path.relative(ctx.getRoot(), auditFile)}.`,
          next,
        };
      });
    });

  preflight
    .command('dry-run <experiment_id>')
    .description('Run preflight audit checks against local app-emitted JSONL without PostHog.')
    .requiredOption('--events-file <path>', 'Local JSONL file containing app-emitted events.')
    .option('--reports-dir <path>', 'Optional directory of preflight report JSON files.')
    .action(async (experimentId: string, opts: { eventsFile: string; reportsDir?: string }) => {
      await wrap(`${commandPrefix} dry-run`, ctx, async () => {
        await requireInitialized(ctx.getRoot());
        const store = new Store(ctx.getRoot());
        const exp = await store.getExperiment(experimentId);
        if (!exp) throw new GrowthError('not_found', `Experiment "${experimentId}" not found.`);
        const events = await readLocalEventsAsExperimentEvents(ctx.getRoot(), opts.eventsFile, exp);
        const reports = opts.reportsDir ? await readReportsFromDir(ctx.getRoot(), opts.reportsDir) : [];
        const now = new Date().toISOString();
        const run: GrowthRun = {
          id: `dryrun_${timestampId()}`,
          type: 'preflight',
          experiment_id: experimentId,
          status: 'completed',
          created_at: now,
          completed_at: now,
          event_window: { after: '1970-01-01T00:00:00.000Z', before: now },
          agents: reports.map((report, index) => ({
            agent_id: `dryrun_agent_${index + 1}`,
            browser: false,
            variant_id: report.variant_observed ?? undefined,
            url_file: '',
            prompt_file: '',
            report_schema_file: '',
            policy_file: '',
          })),
          artifacts: {
            events_file: path.relative(ctx.getRoot(), path.resolve(ctx.getRoot(), opts.eventsFile)),
            ...(opts.reportsDir ? { reports_dir: path.relative(ctx.getRoot(), path.resolve(ctx.getRoot(), opts.reportsDir)) } : {}),
          },
          warnings: [
            {
              code: 'LOCAL_DRY_RUN',
              message:
                'Local dry-run validates instrumentation shape and synthetic labels only. A real provider preflight is still required before launch.',
            },
          ],
        };
        const audit = await auditPreflight(ctx.getRoot(), run, { eventsOverride: events, reportsOverride: reports, dryRun: true });
        const markdown = auditMarkdown(run, audit);
        return {
          data: {
            run,
            run_id: run.id,
            audit,
            markdown,
          },
          warnings: run.warnings,
          humanText: markdown,
          next: {
            command:
              audit.recommendation === 'ready_for_posthog_preflight'
                ? `growth preflight prepare ${experimentId} --agents 4 --browser --json`
                : `growth preflight dry-run ${experimentId} --events-file ${opts.eventsFile} --json`,
            until:
              audit.recommendation === 'ready_for_posthog_preflight'
                ? 'local instrumentation is ready for provider-backed preflight'
                : `recommendation is not ${audit.recommendation}`,
          },
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
        const next = await nextAfterAudit(ctx.getRoot(), run, audit);
        return {
          data: { run, audit, audit_file: audit.audit_file, markdown },
          humanText: opts.markdown ? markdown : `Wrote ${path.relative(ctx.getRoot(), auditFile)}.`,
          next,
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

interface PacketScenario {
  id: string;
  goal: string;
  instructions: string[];
  expected_events?: string[];
}

function packetScenario(exp: Experiment, index: number): PacketScenario {
  const configured = exp.preflight?.scenarios ?? [];
  const scenarios = configured.length
    ? configured.map((scenario) => ({
        id: scenario.id,
        goal: scenario.goal,
        instructions: scenario.instructions ?? [
          'Use the product naturally for this scenario.',
          'Report blockers and list any expected events you could not naturally exercise.',
        ],
        expected_events: scenario.expected_events,
      }))
    : inferredScenarios(exp);
  return scenarios[index % scenarios.length];
}

function inferredScenarios(exp: Experiment): PacketScenario[] {
  const primary = exp.metrics.find((metric) => metric.role === 'primary') ?? exp.metrics[0];
  const scenarios: PacketScenario[] = [
    {
      id: 'primary_metric_path',
      goal: primary
        ? `Exercise the user path that would naturally emit primary metric "${primary.id}" (${primary.event}).`
        : 'Exercise the most obvious product path controlled by this experiment.',
      instructions: [
        'Use the product naturally within the visible UI.',
        'Try to reach the outcome described by the experiment hypothesis and primary metric.',
        'If the path is unavailable or unclear, report the blocker instead of inventing a route.',
      ],
      expected_events: primary ? metricEvents(primary) : expectedEvents(exp),
    },
  ];
  const guardrails = exp.metrics.filter((metric) => metric.role === 'guardrail');
  if (guardrails.length) {
    scenarios.push({
      id: 'guardrail_metric_observation',
      goal: 'Observe whether any declared guardrail condition appears during realistic product use.',
      instructions: [
        `Declared guardrail events: ${unique(guardrails.flatMap(metricEvents)).join(', ')}.`,
        'Use only safe, reversible actions available in the UI.',
        'Do not force destructive behavior; list unreachable guardrail events in missing_expected_events.',
      ],
      expected_events: unique(guardrails.flatMap(metricEvents)),
    });
  }
  const covered = new Set(scenarios.flatMap((scenario) => scenario.expected_events ?? []));
  const remaining = expectedEvents(exp).filter((event) => !covered.has(event));
  if (remaining.length) {
    scenarios.push({
      id: 'declared_event_surface',
      goal: 'Explore adjacent product paths that may emit remaining declared events.',
      instructions: [
        `Remaining declared events: ${remaining.join(', ')}.`,
        'Stay within the browser UI and behave like a normal user.',
        'List any events you could not naturally exercise in missing_expected_events.',
      ],
      expected_events: remaining,
    });
  }
  return scenarios;
}

function metricEvents(metric: Experiment['metrics'][number]): string[] {
  return metric.denominator_event ? [metric.denominator_event, metric.event] : [metric.event];
}

function unique(values: string[]): string[] {
  return Array.from(new Set(values)).sort();
}

function packetPrompt(exp: Experiment, scenario: PacketScenario): string {
  return [
    BASE_PACKET_PROMPT.trimEnd(),
    '',
    `Experiment: ${exp.id}`,
    `Scenario: ${scenario.id}`,
    `Goal: ${scenario.goal}`,
    '',
    'Scenario instructions:',
    ...scenario.instructions.map((instruction) => `- ${instruction}`),
    '',
    'Expected event surface for your report:',
    ...(scenario.expected_events ?? expectedEvents(exp)).map((event) => `- ${event}`),
    '',
    'If you cannot naturally exercise an expected event, list it in missing_expected_events.',
    '',
  ].join('\n');
}

function expectedEvents(exp: Experiment): string[] {
  const out = new Set<string>();
  for (const metric of exp.metrics) {
    out.add(metric.event);
    if (metric.denominator_event) out.add(metric.denominator_event);
  }
  for (const event of exp.instrumentation?.events ?? []) out.add(event.event);
  return Array.from(out).sort();
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
  primary_goal_observed: boolean;
  stop_reason: string;
  variant_observed?: string | null;
  primary_metric_events_observed: string[];
  guardrail_observed?: boolean;
  confusing_or_broken: string[];
  blockers: string[];
  internal_ui_visible: string[];
  missing_expected_events: string[];
  screenshot_or_trace_artifacts: string[];
  completed_onboarding?: boolean;
  conversion_observed?: boolean;
  activation_observed?: boolean;
  guardrail_issue_observed?: boolean;
  auth_or_payment_blockers?: string[];
}

type AuditRecommendation =
  | 'ready_for_real_users'
  | 'ready_for_posthog_preflight'
  | 'fix_instrumentation'
  | 'fix_app_instrumentation'
  | 'extend_preflight_coverage'
  | 'fix_variant_reachability'
  | 'fix_ux_blocker'
  | 'fix_blocker'
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

interface AuditPreflightOptions {
  eventsOverride?: ExperimentEvent[];
  reportsOverride?: PreflightReportSummary[];
  dryRun?: boolean;
  providerBacked?: boolean;
}

async function auditPreflight(root: string, run: GrowthRun, opts: AuditPreflightOptions = {}): Promise<PreflightAudit> {
  const store = new Store(root);
  const exp = run.experiment_id ? await store.getExperiment(run.experiment_id) : null;
  const reports = opts.reportsOverride ?? (await readReports(root, run));
  const events = opts.eventsOverride ?? (run.experiment_id ? filterEventsForPreflightRun(await store.readEvents(run.experiment_id), run) : []);
  const latestLocalVerification = run.experiment_id ? await readLatestInstrumentationVerification(root, run.experiment_id) : null;
  const checks: PreflightAudit['checks'] = [];
  const expectedAgents = opts.dryRun && reports.length === 0 ? 0 : run.agents?.length ?? 0;
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
    status:
      opts.dryRun && expectedAgents === 0
        ? 'warn'
        : reports.length >= expectedAgents && expectedAgents > 0
          ? 'pass'
          : 'fail',
    message:
      opts.dryRun && expectedAgents === 0
        ? 'No agent reports supplied for local dry-run.'
        : `Reports attached: ${reports.length} / ${expectedAgents}`,
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
    evidence: {
      required: Array.from(requiredEvents),
      observed: Array.from(eventNames),
      reported_missing: reportedMissingEvents,
      latest_local_verification: latestLocalVerification,
      attribution:
        missingEvents.length > 0 && latestLocalVerification?.ok
          ? 'synthetic_coverage_gap'
          : missingEvents.length > 0
            ? 'app_or_coverage_gap'
            : 'ok',
    },
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

  const blockers = reports.flatMap((report) => report.blockers.map((note) => ({ file: report.file, note })));
  checks.push({
    id: 'blockers',
    status: blockers.length === 0 ? 'pass' : 'fail',
    message: blockers.length === 0 ? 'No access, environment, or product blockers were reported.' : `${blockers.length} blocker(s).`,
    evidence: blockers,
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

  const recommendation = recommendationFor(checks, {
    dryRun: !!opts.dryRun,
    latestLocalVerification,
    providerBacked: opts.providerBacked ?? hasProviderBackedPull(run),
  });
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
  const requiredEventsCheck = audit.checks.find((check) => check.id === 'required_events');
  const requiredEvents = requiredEventsCheck?.message ?? '';
  const syntheticLabelsCheck = audit.checks.find((check) => check.id === 'synthetic_labels');
  const unlabeled = readUnlabeledEvidence(syntheticLabelsCheck?.evidence);
  const requiredAttribution = readRequiredAttribution(requiredEventsCheck?.evidence);
  const stopReasons = countBy(reports.map((report) => report.stop_reason || '(missing)'));
  const variants = countBy(reports.map((report) => report.variant_observed || '(not reported)'));
  const primaryGoals = reports.filter((report) => report.primary_goal_observed).length;
  const guardrails = reports.filter((report) => report.guardrail_observed).length;
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
    ...(requiredAttribution ? [`Required event attribution: ${requiredAttribution}`] : []),
    `Primary goal observed: ${primaryGoals} / ${reports.length}`,
    `Guardrail observed: ${guardrails} / ${reports.length}`,
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
    ...(unlabeled.length
      ? [
          '## Synthetic Label Evidence',
          '',
          ...unlabeled.map((event) => `- ${event.event} user=${event.user_id ?? '(unknown)'} variant=${event.variant_id ?? '(missing)'} ts=${event.timestamp ?? '(missing)'}`),
          '',
        ]
      : []),
    '## Artifacts',
    '',
    ...Object.entries(run.artifacts).map(([key, value]) => `- ${key}: ${value}`),
    '',
  ].join('\n');
}

function recommendationFor(
  checks: PreflightAudit['checks'],
  opts: { dryRun: boolean; latestLocalVerification: { ok: boolean } | null; providerBacked: boolean },
): AuditRecommendation {
  const failed = new Set(checks.filter((check) => check.status === 'fail').map((check) => check.id));
  if (failed.has('internal_ui_visible') || failed.has('synthetic_labels')) return 'do_not_launch';
  if (failed.has('required_events')) {
    return opts.latestLocalVerification?.ok ? 'extend_preflight_coverage' : 'fix_app_instrumentation';
  }
  if (failed.has('variant_reachability') || failed.has('reports_attached')) return 'fix_variant_reachability';
  if (failed.has('blockers') || failed.has('auth_or_environment')) return 'fix_blocker';
  if (failed.has('ux_blockers')) return 'fix_ux_blocker';
  if (opts.dryRun || !opts.providerBacked) return 'ready_for_posthog_preflight';
  return 'ready_for_real_users';
}

function hasProviderBackedPull(run: GrowthRun): boolean {
  return Object.keys(run.artifacts ?? {}).some((key) => key.startsWith('pull_') && key !== 'pull_local');
}

async function nextAfterAudit(root: string, run: GrowthRun, audit: PreflightAudit) {
  if (audit.recommendation === 'ready_for_real_users') {
    return {
      command: `growth analyze ${run.experiment_id ?? '<experiment_id>'} --segment real-users --json`,
      until: 'real-user launch and measurement are ready to begin',
    };
  }
  if (audit.recommendation === 'ready_for_posthog_preflight') {
    const connectors = await listConnectors(root);
    const provider = connectors.find((connector) => connector.source !== 'local' && connector.kind !== 'native-app');
    return provider
      ? {
          command: `growth preflight pull ${run.id} --source ${provider.source} --json`,
          until: 'provider-backed synthetic events are pulled and audited',
        }
      : {
          command: 'growth connector import stripe-projects --json',
          until: 'a provider connector is configured for provider-backed preflight',
        };
  }
  return {
    command: `growth preflight audit ${run.id} --json`,
    until: `recommendation is not ${audit.recommendation}`,
  };
}

function eventSummary(event: ExperimentEvent): Record<string, unknown> {
  return {
    event: event.event,
    user_id: event.user_id,
    variant_id: event.variant_id,
    timestamp: event.timestamp,
  };
}

function summarizeReport(report: PreflightReportSummary): Record<string, unknown> {
  return {
    primary_goal_observed: report.primary_goal_observed,
    stop_reason: report.stop_reason,
    variant_observed: report.variant_observed ?? null,
    guardrail_observed: report.guardrail_observed ?? false,
    missing_expected_events: report.missing_expected_events ?? [],
    confusing_or_broken_count: report.confusing_or_broken?.length ?? 0,
    blockers_count: report.blockers?.length ?? 0,
    internal_ui_visible_count: report.internal_ui_visible?.length ?? 0,
  };
}

function synthesizeReportsFromEvents(run: GrowthRun, exp: Experiment, events: ExperimentEvent[]): PreflightReportSummary[] {
  const required = expectedEvents(exp);
  const primaryEvents = unique(exp.metrics.filter((metric) => metric.role === 'primary').flatMap(metricEvents));
  return (run.agents ?? []).map((agent, index) => {
    const agentEvents = events.filter((event) => event.payload?.agent_run_id === agent.agent_id);
    const observed = unique(agentEvents.map((event) => event.event));
    const observedSet = new Set(observed);
    const missing = required.filter((event) => !observedSet.has(event));
    const primaryObserved = primaryEvents.length > 0 && primaryEvents.every((event) => observedSet.has(event));
    return {
      file: `synthetic-events:${agent.agent_id}`,
      primary_goal_observed: primaryObserved,
      stop_reason: missing.length === 0 || primaryObserved ? 'completed' : 'stuck',
      variant_observed: agentEvents.find((event) => event.variant_id)?.variant_id ?? agent.variant_id ?? null,
      primary_metric_events_observed: primaryEvents.filter((event) => observedSet.has(event)),
      guardrail_observed: exp.metrics.some((metric) => metric.role === 'guardrail' && observedSet.has(metric.event)),
      confusing_or_broken: [],
      blockers: [],
      internal_ui_visible: [],
      missing_expected_events: missing,
      screenshot_or_trace_artifacts: [],
    };
  });
}

async function readLocalEventsAsExperimentEvents(root: string, eventsFile: string, exp: Experiment): Promise<ExperimentEvent[]> {
  const resolved = path.resolve(root, eventsFile);
  const raw = await fs.readFile(resolved, 'utf8');
  const connector = defaultLocalConnector(path.relative(root, resolved));
  for (const event of expectedEvents(exp)) {
    connector.mappings[event] = connector.mappings[event] ?? {
      framework_event: event,
      payload_paths: {
        agent_generated: 'properties.agent_generated',
        agent_run_id: 'properties.agent_run_id',
        session_id: 'properties.session_id',
      },
    };
  }
  const events: ExperimentEvent[] = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    const mapped = mapEvent(connector, parsed);
    if (mapped.event) events.push(mapped.event);
  }
  return events;
}

async function readReportsFromDir(root: string, reportsDir: string): Promise<PreflightReportSummary[]> {
  const dir = path.resolve(root, reportsDir);
  const reports: PreflightReportSummary[] = [];
  let files: string[] = [];
  try {
    files = await fs.readdir(dir);
  } catch {
    throw new GrowthError('reports_dir_not_found', `Reports directory not found: ${path.relative(root, dir)}`);
  }
  for (const file of files.sort()) {
    if (!file.endsWith('.json')) continue;
    const target = path.join(dir, file);
    try {
      const parsed = JSON.parse(await fs.readFile(target, 'utf8')) as PreflightReportSummary;
      const legacyBlockers = Array.isArray(parsed.auth_or_payment_blockers) ? parsed.auth_or_payment_blockers : [];
      const blockers = Array.isArray(parsed.blockers) ? parsed.blockers : legacyBlockers;
      reports.push({
        ...parsed,
        file: path.relative(root, target),
        primary_goal_observed: parsed.primary_goal_observed ?? parsed.completed_onboarding ?? false,
        primary_metric_events_observed: Array.isArray(parsed.primary_metric_events_observed)
          ? parsed.primary_metric_events_observed
          : [],
        guardrail_observed: parsed.guardrail_observed ?? parsed.guardrail_issue_observed ?? false,
        confusing_or_broken: Array.isArray(parsed.confusing_or_broken) ? parsed.confusing_or_broken : [],
        blockers,
        internal_ui_visible: Array.isArray(parsed.internal_ui_visible) ? parsed.internal_ui_visible : [],
        missing_expected_events: Array.isArray(parsed.missing_expected_events) ? parsed.missing_expected_events : [],
        screenshot_or_trace_artifacts: Array.isArray(parsed.screenshot_or_trace_artifacts)
          ? parsed.screenshot_or_trace_artifacts
          : [],
      });
    } catch {
      // ignore malformed optional dry-run reports
    }
  }
  return reports;
}

async function readLatestInstrumentationVerification(root: string, experimentId: string): Promise<{ id: string; file: string; ok: boolean } | null> {
  const runsDir = paths(root).runsDir;
  let dirs: string[] = [];
  try {
    dirs = await fs.readdir(runsDir);
  } catch {
    return null;
  }
  for (const dir of dirs.filter((name) => name.startsWith('instrumentation_')).sort().reverse()) {
    try {
      const runFile = path.join(runsDir, dir, 'run.json');
      const run = JSON.parse(await fs.readFile(runFile, 'utf8')) as GrowthRun;
      if (run.experiment_id !== experimentId) continue;
      const verifyFile = run.artifacts.verify_result;
      if (!verifyFile) continue;
      const verify = JSON.parse(await fs.readFile(path.join(root, verifyFile), 'utf8')) as {
        actual_event_check?: { ok?: boolean };
      };
      return { id: run.id, file: verifyFile, ok: verify.actual_event_check?.ok === true };
    } catch {
      // keep looking
    }
  }
  return null;
}

function readUnlabeledEvidence(evidence: unknown): Array<Record<string, unknown>> {
  if (!evidence || typeof evidence !== 'object') return [];
  const unlabeled = (evidence as { unlabeled?: unknown }).unlabeled;
  return Array.isArray(unlabeled) ? (unlabeled as Array<Record<string, unknown>>).slice(0, 10) : [];
}

function readRequiredAttribution(evidence: unknown): string | null {
  if (!evidence || typeof evidence !== 'object') return null;
  const attribution = (evidence as { attribution?: unknown }).attribution;
  return typeof attribution === 'string' && attribution !== 'ok' ? attribution : null;
}

function timestampId(): string {
  return new Date().toISOString().replace(/[-:.]/g, '');
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
      const legacyBlockers = Array.isArray(parsed.auth_or_payment_blockers) ? parsed.auth_or_payment_blockers : [];
      const blockers = Array.isArray(parsed.blockers) ? parsed.blockers : legacyBlockers;
      reports.push({
        ...parsed,
        file: path.relative(root, file),
        primary_goal_observed: parsed.primary_goal_observed ?? parsed.completed_onboarding ?? false,
        primary_metric_events_observed: Array.isArray(parsed.primary_metric_events_observed)
          ? parsed.primary_metric_events_observed
          : [],
        guardrail_observed: parsed.guardrail_observed ?? parsed.guardrail_issue_observed ?? false,
        confusing_or_broken: Array.isArray(parsed.confusing_or_broken) ? parsed.confusing_or_broken : [],
        blockers,
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
