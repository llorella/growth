/**
 * Single command that prints schema + active experiments + connectors +
 * state + conventions in one envelope blob. Agents call this to prime
 * themselves with current ground truth before deciding what to do.
 */
import type { Command } from 'commander';
import { wrap, type RunCtx } from '../lib/runner.js';
import { requireInitialized } from '../lib/gating.js';
import { Store } from '../lib/store.js';
import { listConnectors } from '../connectors/persistence.js';
import { readShared } from '../lib/state.js';
import { connectorSchema, eventTaxonomySchema, experimentSchema, preflightReportSchema } from '../core/experiment/schema.js';
import { CATALOG } from '../lib/defaults.js';
import { projectProfileUnknowns, readProjectProfile } from '../lib/project-profile.js';
import { resolveAppUrl } from '../lib/app-url.js';

const CONVENTIONS = [
  'All commands accept --json and return a stable envelope.',
  'Every mutation requires `growth init` first; pre-init mutations fail with code "not_initialized".',
  'Experiment configs live in .growth/experiments/<id>.json and should be created with `growth experiment create`.',
  'Templates live in .growth/templates/<name>.json and are partial specs merged at create time.',
  'Connectors live in .growth/connectors/<source>.json and are validated by `growth connector validate`.',
  '.growth/data/events.jsonl is append-only. `pull` is idempotent by idempotency_key with a stable hash fallback.',
  '.growth/audit.jsonl logs every CLI invocation.',
  'First variant in `variants` must be the control variant with id "control".',
  'Use preflight before exposing any experiment to real users.',
  'Preflight packet URLs carry agent_generated, agent_run_id, experiment_id, and variant query params.',
  'Persist preflight query params across client-side navigation before emitting synthetic events.',
  'Use variant_id as the canonical emitted event property; the variant query param only forces a synthetic branch.',
  'Every synthetic event must have payload agent_generated=true and a non-empty agent_run_id.',
  'Prepared preflight runs use a half-open event window: after <= timestamp < before.',
  '`growth preflight plan <id> --json` chooses the evidence source, target route, readiness ceiling, and next command.',
  'When preflight plan returns browser_context.requires_authenticated_session=true, use an authenticated test session and report login/paywall blockers explicitly.',
  '`static_ready` means specs, mappings, and static checks are plausible; it is not emitted-event proof.',
  '`local_synthetic_ready` means local app-emitted synthetic events passed audit; it does not prove provider ingestion.',
  '`ready_for_provider_preflight` means local synthetic evidence passed; it is not provider-backed or real-user evidence.',
  '`provider_preflight_passed` means synthetic traffic was pulled through a provider; it is still not a ship decision.',
  'Never treat agent-generated traffic as real-user evidence.',
  'Built-in templates are examples; prefer the user-provided experiment intent and schema when authoring a spec.',
];

export function registerLlmContext(program: Command, ctx: RunCtx): void {
  program
    .command('llm-context')
    .description('Prime an agent with schema, state, active configs, and conventions.')
    .action(async () => {
      await wrap('growth llm-context', ctx, async () => {
        await requireInitialized(ctx.getRoot());
        const root = ctx.getRoot();
        const store = new Store(root);
        const [shared, experiments, connectors, templates] = await Promise.all([
          readShared(root),
          store.listExperiments(),
          listConnectors(root),
          store.listTemplates(),
        ]);
        const projectProfile = await readProjectProfile(root);
        const detectedFramework = projectProfile.framework?.id ?? 'unknown';
        const appUrl = await resolveAppUrl(root, detectedFramework);
        return {
          data: {
            framework: { name: 'growth', version: ctx.version, root },
            project_profile: projectProfile,
            project_unknowns: projectProfileUnknowns(projectProfile),
            project_hints: {
              framework: {
                detected: detectedFramework,
                source: projectProfile.framework?.source ?? 'unconfigured',
                advisory_only: true,
              },
            },
            local_servers: { app_url: appUrl },
            state: { shared },
            schemas: {
              experiment: experimentSchema as unknown as Record<string, unknown>,
              connector: connectorSchema as unknown as Record<string, unknown>,
              event_taxonomy: eventTaxonomySchema as unknown as Record<string, unknown>,
              preflight_report: preflightReportSchema as unknown as Record<string, unknown>,
            },
            catalog: CATALOG,
            commands: [
              'growth status --json',
              'growth project show --json',
              'growth project configure --framework <id> --app-url <url> --json',
              'growth project route add <id> --path <path> --json',
              'growth project auth-context add <id> --requires-session --json',
              'growth schema experiment --json',
              'growth experiment create <id> --from-file <spec.json> --json',
              'growth experiment implementation set <id> --variant <variant_id> --branch <branch> --worktree <path> --json',
              'growth instrumentation plan <id> --json',
              'growth instrumentation verify <id> --json',
              'growth preflight plan <id> --json',
              'growth preflight run <id> --agents 4 --browser --json',
              'growth preflight prepare <id> --agents 4 --browser --app-url <packet_app_url> --json',
              'growth preflight pull <run_id> --source <provider> --json',
              'growth preflight audit <run_id> --json',
              'growth pull <id> --source <source> --after <iso> --json',
            ],
            experiments: experiments.map((e) => ({
              id: e.id,
              name: e.name,
              status: e.status,
              hypothesis: e.hypothesis,
              variants: e.variants.map((v) => v.id),
              metrics: e.metrics.map((m) => ({
                id: m.id,
                role: m.role,
                event: m.event,
                denominator_event: m.denominator_event,
              })),
              started_at: e.started_at,
            })),
            connectors: connectors.map((c) => ({
              source: c.source,
              kind: c.kind,
              mapped_events: Object.keys(c.mappings),
            })),
            templates,
            conventions: CONVENTIONS,
          },
          next:
            experiments.length > 0
              ? {
                  command: `growth preflight plan ${experiments[0].id} --json`,
                  until: 'Growth chooses evidence source, target route, readiness ceiling, and next command',
                }
              : {
                  command: 'growth schema experiment --json',
                  until: 'an experiment spec is authored from the schema or an explicit template choice',
                },
        };
      });
    });
}
