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
import { listConnectors } from '../lib/connectors.js';
import { preflightReportSchema } from '../domain/schema.js';
import type { AgentPacketSummary, GrowthRun } from '../domain/types.js';
import {
  allLocalEvidenceWindow,
  closeEventWindow,
  openEventWindow,
} from '../domain/event-window.js';
import {
  buildAgentUrl,
  launchManual,
  packetPrompt,
  packetScenario,
  packetVariant,
} from '../preflight/packets.js';
import { requiredPreflightEvents } from '../preflight/coverage.js';
import { auditPreflight } from '../preflight/audit.js';
import { auditMarkdown } from '../preflight/markdown.js';
import {
  readLocalEventsAsExperimentEvents,
  readReportsFromDir,
  summarizeReport,
  synthesizeReportsFromEvents,
} from '../preflight/reports.js';
import type { PreflightAudit, PreflightReportSummary } from '../preflight/types.js';

const ajv = new (Ajv2020 as unknown as { new (opts: object): Ajv2020 })({
  allErrors: true,
  strict: false,
});
(addFormats as unknown as (a: Ajv2020) => void)(ajv);
const validatePreflightReport = ajv.compile(preflightReportSchema);

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
                  expected_events: requiredPreflightEvents(exp),
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

          const createdAt = new Date().toISOString();
          const run: GrowthRun = {
            id: runId,
            type: 'preflight',
            experiment_id: experimentId,
            status: 'prepared',
            created_at: createdAt,
            event_window: openEventWindow(createdAt),
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
        run.event_window = closeEventWindow(run.event_window, run.created_at, run.completed_at);
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
        run.event_window = closeEventWindow(run.event_window, run.created_at, run.completed_at);
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
    .description('Run preflight audit checks against local app-emitted JSONL without a provider pull.')
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
          event_window: allLocalEvidenceWindow(now),
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
              audit.recommendation === 'ready_for_provider_preflight'
                ? `growth preflight prepare ${experimentId} --agents 4 --browser --json`
                : `growth preflight dry-run ${experimentId} --events-file ${opts.eventsFile} --json`,
            until:
              audit.recommendation === 'ready_for_provider_preflight'
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

async function nextAfterAudit(root: string, run: GrowthRun, audit: PreflightAudit) {
  if (audit.recommendation === 'provider_preflight_passed') {
    return {
      command: `growth analyze ${run.experiment_id ?? '<experiment_id>'} --segment real-users --json`,
      until: 'real-user launch and measurement are ready to begin',
    };
  }
  if (audit.recommendation === 'ready_for_provider_preflight') {
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

function timestampId(): string {
  return new Date().toISOString().replace(/[-:.]/g, '');
}
