import { promises as fs } from 'node:fs';
import path from 'node:path';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import type { ErrorObject } from 'ajv';
import { allLocalEvidenceWindow, closeEventWindow } from '../evidence/event-window.js';
import type { GrowthRun } from '../experiment/types.js';
import { preflightReportSchema } from '../experiment/schema.js';
import { GrowthError } from '../../lib/envelope.js';
import { paths } from '../../lib/paths.js';
import { pull as pullEvents } from '../../lib/pull.js';
import { Store } from '../../lib/store.js';
import { auditPreflight } from './audit.js';
import { auditMarkdown } from './markdown.js';
import {
  readLocalEventsAsExperimentEvents,
  readReportsFromDir,
  summarizeReport,
  synthesizeReportsFromEvents,
} from './reports.js';
import type { PreflightAudit, PreflightReportSummary } from './types.js';
import { listConnectors } from '../../connectors/persistence.js';
import { preferredPullSource, providerBackedConnector } from './packets.js';

const ajv = new (Ajv2020 as unknown as { new (opts: object): Ajv2020 })({
  allErrors: true,
  strict: false,
});
(addFormats as unknown as (a: Ajv2020) => void)(ajv);
const validatePreflightReport = ajv.compile(preflightReportSchema);

export async function readRun(root: string, runId: string): Promise<GrowthRun> {
  try {
    return JSON.parse(await fs.readFile(path.join(paths(root).runsDir, runId, 'run.json'), 'utf8')) as GrowthRun;
  } catch {
    throw new GrowthError('run_not_found', `Run "${runId}" not found.`);
  }
}

export async function writeRun(root: string, run: GrowthRun): Promise<void> {
  await fs.writeFile(path.join(paths(root).runsDir, run.id, 'run.json'), JSON.stringify(run, null, 2) + '\n');
}

export async function attachPreflightReport(
  root: string,
  runId: string,
  opts: { agent: number; file: string },
) {
  const run = await readRun(root, runId);
  const reportRaw = await fs.readFile(path.resolve(root, opts.file), 'utf8');
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
  const p = paths(root);
  const target = path.join(p.runsDir, runId, 'reports', `agent-${opts.agent}.report.json`);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, reportRaw.endsWith('\n') ? reportRaw : reportRaw + '\n');
  run.artifacts[`agent_${opts.agent}_report`] = path.relative(root, target);
  await writeRun(root, run);
  const agent = run.agents[opts.agent - 1];
  return {
    data: {
      status: 'attached',
      run,
      agent_number: opts.agent,
      agent_id: agent?.agent_id,
      report_path: path.relative(root, target),
      report: path.relative(root, target),
      schema_validation: 'ok',
      report_summary: summarizeReport(report as unknown as PreflightReportSummary),
    },
    humanText: `Attached report for agent ${opts.agent} to ${runId}.`,
    next: {
      command: `growth preflight complete ${runId} --json`,
      until: 'all agent reports are attached and the preflight window can be closed',
    },
  };
}

export async function pullPreflightRun(
  root: string,
  runId: string,
  opts: { source: string; before?: string; limit?: number; allowOverlap: boolean },
) {
  const run = await readRun(root, runId);
  if (!run.experiment_id) {
    throw new GrowthError('run_missing_experiment', `Run "${runId}" is not tied to an experiment.`);
  }
  if (!run.event_window?.after) {
    throw new GrowthError('run_missing_window', `Run "${runId}" does not have an event window.`);
  }
  const before = opts.before ?? run.event_window.before ?? new Date().toISOString();
  const result = await pullEvents(root, {
    experimentId: run.experiment_id,
    source: opts.source,
    after: run.event_window.after,
    before,
    limit: opts.limit,
    runId,
    allowOverlap: opts.allowOverlap,
  });
  run.artifacts[`pull_${opts.source}`] = result.pull_file;
  await writeRun(root, run);
  return {
    data: { run, pull: result },
    humanText: `Pulled ${run.experiment_id} for ${runId} from ${opts.source}.`,
    nextSteps: [`growth preflight audit ${runId} --json`],
    next: {
      command: `growth preflight audit ${runId} --json`,
      until: 'audit recommendation distinguishes provider-backed readiness from local-only preflight readiness',
    },
  };
}

export async function completePreflightRun(root: string, runId: string) {
  const run = await readRun(root, runId);
  run.status = 'completed';
  run.completed_at = new Date().toISOString();
  run.event_window = closeEventWindow(run.event_window, run.created_at, run.completed_at);
  await writeRun(root, run);
  const connectors = await listConnectors(root);
  const preferredSource = preferredPullSource(connectors);
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
}

export async function completeLocalPreflightRun(
  root: string,
  runId: string,
  opts: { eventsFile: string; reportsDir?: string; markdown?: boolean },
) {
  const run = await readRun(root, runId);
  if (!run.experiment_id) {
    throw new GrowthError('run_missing_experiment', `Run "${runId}" is not tied to an experiment.`);
  }
  const store = new Store(root);
  const exp = await store.getExperiment(run.experiment_id);
  if (!exp) throw new GrowthError('not_found', `Experiment "${run.experiment_id}" not found.`);
  const events = await readLocalEventsAsExperimentEvents(root, opts.eventsFile, exp);
  const reports = opts.reportsDir
    ? await readReportsFromDir(root, opts.reportsDir)
    : synthesizeReportsFromEvents(run, exp, events);
  run.status = 'completed';
  run.completed_at = new Date().toISOString();
  run.event_window = closeEventWindow(run.event_window, run.created_at, run.completed_at);
  run.artifacts.events_file = path.relative(root, path.resolve(root, opts.eventsFile));
  if (opts.reportsDir) {
    run.artifacts.reports_dir = path.relative(root, path.resolve(root, opts.reportsDir));
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
  await writeRun(root, run);
  const audit = await auditPreflight(root, run, { eventsOverride: events, reportsOverride: reports });
  const markdown = auditMarkdown(run, audit);
  const auditFile = path.join(paths(root).runsDir, runId, 'audit.md');
  await fs.writeFile(auditFile, markdown);
  audit.audit_file = path.relative(root, auditFile);
  const next = await nextAfterAudit(root, run, audit);
  return {
    data: { run, audit, audit_file: audit.audit_file, markdown },
    warnings: run.warnings,
    humanText: opts.markdown ? markdown : `Completed ${runId} and wrote ${path.relative(root, auditFile)}.`,
    next,
  };
}

export async function dryRunPreflight(
  root: string,
  experimentId: string,
  opts: { eventsFile: string; reportsDir?: string },
) {
  const store = new Store(root);
  const exp = await store.getExperiment(experimentId);
  if (!exp) throw new GrowthError('not_found', `Experiment "${experimentId}" not found.`);
  const events = await readLocalEventsAsExperimentEvents(root, opts.eventsFile, exp);
  const reports = opts.reportsDir ? await readReportsFromDir(root, opts.reportsDir) : [];
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
      events_file: path.relative(root, path.resolve(root, opts.eventsFile)),
      ...(opts.reportsDir ? { reports_dir: path.relative(root, path.resolve(root, opts.reportsDir)) } : {}),
    },
    warnings: [
      {
        code: 'LOCAL_DRY_RUN',
        message:
          'Local dry-run validates instrumentation shape and synthetic labels only. A real provider preflight is still required before launch.',
      },
    ],
  };
  const audit = await auditPreflight(root, run, { eventsOverride: events, reportsOverride: reports, dryRun: true });
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
          ? `growth preflight run ${experimentId} --agents 4 --browser --json`
          : `growth preflight dry-run ${experimentId} --events-file ${opts.eventsFile} --json`,
      until:
        audit.recommendation === 'ready_for_provider_preflight'
          ? 'local instrumentation is ready for provider-backed preflight'
          : `recommendation is not ${audit.recommendation}`,
    },
  };
}

export async function auditPreflightRun(root: string, runId: string, opts: { markdown?: boolean }) {
  const run = await readRun(root, runId);
  const audit = await auditPreflight(root, run);
  const markdown = auditMarkdown(run, audit);
  const auditFile = path.join(paths(root).runsDir, runId, 'audit.md');
  await fs.writeFile(auditFile, markdown);
  audit.audit_file = path.relative(root, auditFile);
  const next = await nextAfterAudit(root, run, audit);
  return {
    data: { run, audit, audit_file: audit.audit_file, markdown },
    humanText: opts.markdown ? markdown : `Wrote ${path.relative(root, auditFile)}.`,
    next,
  };
}

async function nextAfterAudit(root: string, run: GrowthRun, audit: PreflightAudit) {
  if (audit.recommendation === 'provider_preflight_passed') {
    return {
      command: `growth experiment start ${run.experiment_id ?? '<experiment_id>'} --json`,
      until: 'experiment is ready for real-user launch',
    };
  }
  if (audit.recommendation === 'ready_for_provider_preflight') {
    const connectors = await listConnectors(root);
    const provider = providerBackedConnector(connectors);
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
