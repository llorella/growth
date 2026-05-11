import type { GrowthRun } from '../domain/types.js';
import type { PreflightAudit } from './types.js';

export function auditMarkdown(run: GrowthRun, audit: PreflightAudit): string {
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

