import { promises as fs } from 'node:fs';
import path from 'node:path';
import { paths } from '../lib/paths.js';
import { GrowthError } from '../lib/envelope.js';
import { defaultLocalConnector, mapEvent } from '../lib/connectors.js';
import type { Experiment, ExperimentEvent, GrowthRun } from '../domain/types.js';
import { expectedEvents, metricEvents, unique } from './packets.js';
import type { PreflightReportSummary } from './types.js';

export function summarizeReport(report: PreflightReportSummary): Record<string, unknown> {
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

export function synthesizeReportsFromEvents(run: GrowthRun, exp: Experiment, events: ExperimentEvent[]): PreflightReportSummary[] {
  const required = expectedEvents(exp);
  const primaryEvents = unique(exp.metrics.filter((metric) => metric.role === 'primary').flatMap(metricEvents));
  return (run.agents ?? []).map((agent) => {
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

export async function readLocalEventsAsExperimentEvents(root: string, eventsFile: string, exp: Experiment): Promise<ExperimentEvent[]> {
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

export async function readReportsFromDir(root: string, reportsDir: string): Promise<PreflightReportSummary[]> {
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
      reports.push(normalizeReport(root, target, parsed));
    } catch {
      // Optional dry-run report directories may contain draft or unrelated JSON.
    }
  }
  return reports;
}

export async function readLatestInstrumentationVerification(root: string, experimentId: string): Promise<{ id: string; file: string; ok: boolean } | null> {
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

export async function readReports(root: string, run: GrowthRun): Promise<PreflightReportSummary[]> {
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
      reports.push(normalizeReport(root, file, parsed));
    } catch {
      // attach-report validates canonical reports; ignore stale malformed files.
    }
  }
  return reports;
}

function normalizeReport(root: string, file: string, parsed: PreflightReportSummary): PreflightReportSummary {
  const legacyBlockers = Array.isArray(parsed.auth_or_payment_blockers) ? parsed.auth_or_payment_blockers : [];
  const blockers = Array.isArray(parsed.blockers) ? parsed.blockers : legacyBlockers;
  return {
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
  };
}

