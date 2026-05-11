import type { Experiment, ExperimentEvent, GrowthRun } from '../domain/types.js';
import {
  eventTimestampEvidence,
  isUntrustworthyTimestamp,
  type EventWindowRejection,
} from '../domain/event-window.js';
import { hasSyntheticTrafficLabels } from '../domain/synthetic-traffic.js';
import { requiredPreflightEvents } from './coverage.js';
import type { AuditRecommendation, PreflightAudit, PreflightReportSummary } from './types.js';

export const PREFLIGHT_AUDIT_CHECKS = {
  reportsAttached: 'reports_attached',
  variantReachability: 'variant_reachability',
  eventWindowTimestamps: 'event_window_timestamps',
  requiredEvents: 'required_events',
  uxBlockers: 'ux_blockers',
  blockers: 'blockers',
  internalUiVisible: 'internal_ui_visible',
  syntheticLabels: 'synthetic_labels',
} as const;

export interface LocalInstrumentationVerification {
  id: string;
  file: string;
  ok: boolean;
}

export interface PreflightAuditEvidence {
  run: GrowthRun;
  experiment: Experiment | null;
  reports: PreflightReportSummary[];
  events: ExperimentEvent[];
  eventWindowRejections?: Array<EventWindowRejection<ExperimentEvent>>;
  latestLocalVerification?: LocalInstrumentationVerification | null;
  dryRun?: boolean;
  providerBacked: boolean;
}

export function buildPreflightAudit(evidence: PreflightAuditEvidence): PreflightAudit {
  const {
    run,
    experiment,
    reports,
    events,
    latestLocalVerification = null,
    dryRun = false,
    providerBacked,
  } = evidence;
  const untrustworthyTimestamps = (evidence.eventWindowRejections ?? []).filter((rejection) =>
    isUntrustworthyTimestamp(rejection.reason),
  );
  const checks: PreflightAudit['checks'] = [];
  const expectedAgents = dryRun && reports.length === 0 ? 0 : run.agents?.length ?? 0;
  const expectedVariants = new Set(
    (run.agents ?? []).map((agent) => agent.variant_id).filter((v): v is string => !!v),
  );
  if (expectedVariants.size === 0 && experiment) {
    for (const variant of experiment.variants) expectedVariants.add(variant.id);
  }
  const reportedVariants = new Set(
    reports.map((report) => report.variant_observed).filter((v): v is string => !!v),
  );
  const eventVariants = new Set(events.map((event) => event.variant_id));
  const observedVariants = new Set([...reportedVariants, ...eventVariants]);
  const missingVariants = Array.from(expectedVariants).filter((variant) => !observedVariants.has(variant));

  checks.push({
    id: PREFLIGHT_AUDIT_CHECKS.reportsAttached,
    status:
      dryRun && expectedAgents === 0
        ? 'warn'
        : reports.length >= expectedAgents && expectedAgents > 0
          ? 'pass'
          : 'fail',
    message:
      dryRun && expectedAgents === 0
        ? 'No agent reports supplied for local dry-run.'
        : `Reports attached: ${reports.length} / ${expectedAgents}`,
    evidence: { attached: reports.length, expected: expectedAgents },
  });
  checks.push({
    id: PREFLIGHT_AUDIT_CHECKS.variantReachability,
    status: missingVariants.length === 0 ? 'pass' : 'fail',
    message:
      missingVariants.length === 0
        ? 'Every expected variant was reached.'
        : `Missing variant coverage: ${missingVariants.join(', ')}`,
    evidence: {
      expected: Array.from(expectedVariants),
      observed: Array.from(observedVariants),
      missing: missingVariants,
    },
  });
  checks.push({
    id: PREFLIGHT_AUDIT_CHECKS.eventWindowTimestamps,
    status: untrustworthyTimestamps.length === 0 ? 'pass' : 'fail',
    message:
      untrustworthyTimestamps.length === 0
        ? 'Event timestamps are valid for the preflight window.'
        : `${untrustworthyTimestamps.length} event(s) have missing or invalid timestamps.`,
    evidence: { rejected: untrustworthyTimestamps.slice(0, 20).map(eventTimestampEvidence) },
  });

  const requiredEvents = new Set<string>();
  if (experiment) {
    for (const event of requiredPreflightEvents(experiment)) requiredEvents.add(event);
  }
  const eventNames = new Set(events.map((event) => event.event));
  const missingEvents = Array.from(requiredEvents).filter((event) => !eventNames.has(event));
  const reportedMissingEvents = reports.flatMap((report) => report.missing_expected_events);
  checks.push({
    id: PREFLIGHT_AUDIT_CHECKS.requiredEvents,
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

  const stuckReports = reports.filter(
    (report) => report.stop_reason === 'stuck' || report.stop_reason === 'error',
  );
  const confusing = reports.flatMap((report) =>
    report.confusing_or_broken.map((note) => ({ file: report.file, note })),
  );
  checks.push({
    id: PREFLIGHT_AUDIT_CHECKS.uxBlockers,
    status: stuckReports.length === 0 && confusing.length === 0 ? 'pass' : 'fail',
    message:
      stuckReports.length === 0 && confusing.length === 0
        ? 'No UX blockers were reported.'
        : `${stuckReports.length} stuck/error report(s), ${confusing.length} confusing/broken note(s).`,
    evidence: { stuck_reports: stuckReports.map((report) => report.file), confusing },
  });

  const blockers = reports.flatMap((report) =>
    report.blockers.map((note) => ({ file: report.file, note })),
  );
  checks.push({
    id: PREFLIGHT_AUDIT_CHECKS.blockers,
    status: blockers.length === 0 ? 'pass' : 'fail',
    message:
      blockers.length === 0
        ? 'No access, environment, or product blockers were reported.'
        : `${blockers.length} blocker(s).`,
    evidence: blockers,
  });

  const internalUi = reports.flatMap((report) =>
    report.internal_ui_visible.map((note) => ({ file: report.file, note })),
  );
  checks.push({
    id: PREFLIGHT_AUDIT_CHECKS.internalUiVisible,
    status: internalUi.length === 0 ? 'pass' : 'fail',
    message: internalUi.length === 0 ? 'No internal UI was visible.' : `${internalUi.length} internal UI leak(s).`,
    evidence: internalUi,
  });

  const unlabeled = events.filter((event) => !hasSyntheticTrafficLabels(event));
  checks.push({
    id: PREFLIGHT_AUDIT_CHECKS.syntheticLabels,
    status: unlabeled.length === 0 ? 'pass' : 'fail',
    message:
      unlabeled.length === 0
        ? 'Pulled events are labeled synthetic.'
        : `${unlabeled.length} pulled event(s) missing synthetic labels.`,
    evidence: { unlabeled: unlabeled.slice(0, 20).map(eventSummary) },
  });

  const recommendation = recommendationFor(checks, {
    dryRun,
    latestLocalVerification,
    providerBacked,
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

function recommendationFor(
  checks: PreflightAudit['checks'],
  opts: {
    dryRun: boolean;
    latestLocalVerification: LocalInstrumentationVerification | null;
    providerBacked: boolean;
  },
): AuditRecommendation {
  const failed = new Set(checks.filter((check) => check.status === 'fail').map((check) => check.id));
  if (
    failed.has(PREFLIGHT_AUDIT_CHECKS.internalUiVisible) ||
    failed.has(PREFLIGHT_AUDIT_CHECKS.syntheticLabels)
  ) {
    return 'do_not_launch';
  }
  if (failed.has(PREFLIGHT_AUDIT_CHECKS.eventWindowTimestamps)) return 'fix_app_instrumentation';
  if (failed.has(PREFLIGHT_AUDIT_CHECKS.requiredEvents)) {
    return opts.latestLocalVerification?.ok ? 'extend_preflight_coverage' : 'fix_app_instrumentation';
  }
  if (
    failed.has(PREFLIGHT_AUDIT_CHECKS.variantReachability) ||
    failed.has(PREFLIGHT_AUDIT_CHECKS.reportsAttached)
  ) {
    return 'fix_variant_reachability';
  }
  if (failed.has(PREFLIGHT_AUDIT_CHECKS.blockers) || failed.has('auth_or_environment')) {
    return 'fix_blocker';
  }
  if (failed.has(PREFLIGHT_AUDIT_CHECKS.uxBlockers)) return 'fix_ux_blocker';
  if (opts.dryRun || !opts.providerBacked) return 'ready_for_provider_preflight';
  return 'provider_preflight_passed';
}

function eventSummary(event: ExperimentEvent): Record<string, unknown> {
  return {
    event: event.event,
    user_id: event.user_id,
    variant_id: event.variant_id,
    timestamp: event.timestamp,
  };
}
