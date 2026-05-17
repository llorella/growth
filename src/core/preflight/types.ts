import type { ExperimentEvent } from '../experiment/types.js';

export interface PacketScenario {
  id: string;
  goal: string;
  instructions: string[];
  expected_events?: string[];
}

export interface PreflightReportSummary {
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

export type AuditRecommendation =
  | 'provider_preflight_passed'
  | 'ready_for_provider_preflight'
  | 'fix_instrumentation'
  | 'fix_app_instrumentation'
  | 'extend_preflight_coverage'
  | 'fix_variant_reachability'
  | 'fix_ux_blocker'
  | 'fix_blocker'
  | 'fix_auth_or_environment'
  | 'do_not_launch';

export interface AuditRecommendationDetail {
  action: AuditRecommendation;
  summary: string;
}

export interface PreflightAudit {
  run_id: string;
  experiment_id?: string;
  recommendation: AuditRecommendation;
  recommendation_detail: AuditRecommendationDetail;
  checks: Array<{ id: string; status: 'pass' | 'warn' | 'fail'; message: string; evidence?: unknown }>;
  reports: PreflightReportSummary[];
  synthetic_only: true;
  audit_file: string;
}

export interface AuditPreflightOptions {
  eventsOverride?: ExperimentEvent[];
  reportsOverride?: PreflightReportSummary[];
  dryRun?: boolean;
  providerBacked?: boolean;
}
