import { Store } from '../lib/store.js';
import { listConnectors } from '../lib/connectors.js';
import type { ExperimentEvent, GrowthRun } from '../domain/types.js';
import { expectedEvents } from './packets.js';
import { readLatestInstrumentationVerification, readReports } from './reports.js';
import type { AuditPreflightOptions, AuditRecommendation, PreflightAudit } from './types.js';

export async function auditPreflight(root: string, run: GrowthRun, opts: AuditPreflightOptions = {}): Promise<PreflightAudit> {
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
    for (const event of expectedEvents(exp)) requiredEvents.add(event);
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
    providerBacked: opts.providerBacked ?? (await hasProviderBackedPull(root, run)),
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
  if (opts.dryRun || !opts.providerBacked) return 'ready_for_provider_preflight';
  return 'provider_preflight_passed';
}

async function hasProviderBackedPull(root: string, run: GrowthRun): Promise<boolean> {
  const providerSources = new Set(
    (await listConnectors(root))
      .filter((connector) => connector.source !== 'local' && connector.kind !== 'native-app')
      .map((connector) => connector.source),
  );
  return Object.keys(run.artifacts ?? {}).some((key) => {
    if (!key.startsWith('pull_')) return false;
    return providerSources.has(key.slice('pull_'.length));
  });
}

function eventSummary(event: ExperimentEvent): Record<string, unknown> {
  return {
    event: event.event,
    user_id: event.user_id,
    variant_id: event.variant_id,
    timestamp: event.timestamp,
  };
}

