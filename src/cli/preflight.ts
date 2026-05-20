import type { Command } from 'commander';
import { wrap, type RunCtx } from '../lib/runner.js';
import { requireInitialized } from '../lib/gating.js';
import { Store } from '../lib/store.js';
import { GrowthError } from '../lib/envelope.js';
import { readProjectProfile } from '../lib/project-profile.js';
import { resolveAppUrl } from '../lib/app-url.js';
import { listConnectors } from '../connectors/persistence.js';
import { resolvePreflightPlan } from '../core/preflight/plan.js';
import {
  planWarnings,
  preparePreflightPackets,
  resolvePreflightPacketContext,
  type PreflightPacketOptions,
} from '../core/preflight/packets.js';
import {
  attachPreflightReport,
  auditPreflightRun,
  completeLocalPreflightRun,
  completePreflightRun,
  dryRunPreflight,
  execPreflightAgent,
  pullPreflightRun,
  readRun,
} from '../core/preflight/runs.js';

export function registerPreflight(program: Command, ctx: RunCtx): void {
  const preflight = program.command('preflight').description('Prepare, pull, and audit synthetic browser-agent preflights.');
  const commandPrefix = 'growth preflight';

  preflight
    .command('plan <experiment_id>')
    .description('Resolve evidence source, target route, readiness ceiling, and next preflight command.')
    .option('--app-url <url>', 'Application URL agents should open.')
    .option('--base-url <url>', 'Alias for --app-url.')
    .action(async (experimentId: string, opts: { appUrl?: string; baseUrl?: string }) => {
      await wrap(`${commandPrefix} plan`, ctx, async () => {
        await requireInitialized(ctx.getRoot());
        if (opts.appUrl && opts.baseUrl && opts.appUrl !== opts.baseUrl) {
          throw new GrowthError('conflicting_app_urls', '--app-url and --base-url were both provided with different values.');
        }
        const root = ctx.getRoot();
        const store = new Store(root);
        const exp = await store.getExperiment(experimentId);
        if (!exp) throw new GrowthError('not_found', `Experiment "${experimentId}" not found.`);
        const projectProfile = await readProjectProfile(root);
        const framework = projectProfile.framework?.id ?? 'unknown';
        const appUrl = await resolveAppUrl(root, framework, opts.appUrl ?? opts.baseUrl);
        const connectors = await listConnectors(root);
        const plan = await resolvePreflightPlan({
          root,
          experiment: exp,
          connectors,
          framework,
          projectProfile,
          appUrl,
        });
        const warnings = planWarnings(plan);
        return {
          data: { plan },
          warnings,
          humanText: JSON.stringify(plan, null, 2),
          nextSteps: [
            `Evidence preference: ${plan.evidence.preferred_evidence}.`,
            `Packet app URL: ${plan.packet_app_url}.`,
            `Readiness ceiling: ${plan.evidence.readiness_ceiling}.`,
            ...(plan.target_route_source.kind === 'default_root'
              ? ['If the experiment starts somewhere other than /, run growth project route add <id> --path <path> --json.']
              : []),
            ...(plan.browser_context.requires_authenticated_session
              ? ['Browser packets require an authenticated test session for the target route.']
              : []),
            plan.next_command,
          ],
          next: {
            command: plan.next_command,
            until: plan.readiness.blocked.length
              ? 'blocked evidence setup is resolved'
              : 'preflight advances to the next readiness tier',
          },
        };
      });
    });

  preflight
    .command('run <experiment_id>')
    .description('Plan the preflight and prepare packets when the planned evidence path is unblocked.')
    .option('--agents <n>', 'Number of agent packets.', (v) => parseInt(v, 10), 4)
    .option('--browser', 'Prepare browser URLs and browser-use policy.', false)
    .option('--app-url <url>', 'Application URL agents should open.')
    .option('--base-url <url>', 'Alias for --app-url.')
    .option('--force-variant <variant>', 'Force a variant in packet URLs for test mode.')
    .option('--no-balance-variants', 'Do not force round-robin variants in packet URLs.')
    .action(async (experimentId: string, opts: PreflightPacketOptions) => {
      await wrap<unknown>(`${commandPrefix} run`, ctx, async () => {
        await requireInitialized(ctx.getRoot());
        const resolved = await resolvePreflightPacketContext(ctx.getRoot(), experimentId, opts);
        if (resolved.plan.readiness.blocked.length) {
          return {
            data: {
              status: 'blocked',
              plan: resolved.plan,
              run: null,
            },
            humanText: JSON.stringify(resolved.plan, null, 2),
            warnings: [
              {
                code: 'PREFLIGHT_BLOCKED',
                message: resolved.plan.readiness.blocked.join(' '),
              },
            ],
            nextSteps: [resolved.plan.next_command],
            next: {
              command: resolved.plan.next_command,
              until: 'blocked evidence setup is resolved',
            },
          };
        }
        const prepared = await preparePreflightPackets(ctx.getRoot(), experimentId, opts, resolved);
        return {
          ...prepared,
          data: {
            ...prepared.data,
            status: 'prepared',
          },
        };
      });
    });

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
          const resolved = await resolvePreflightPacketContext(ctx.getRoot(), experimentId, opts);
          return preparePreflightPackets(ctx.getRoot(), experimentId, opts, resolved);
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
    .command('exec <run_id>')
    .description('Return execution context for one agent packet, including agent-browser commands.')
    .requiredOption('--agent <n>', 'Agent number (1-based).', (v) => parseInt(v, 10))
    .action(async (runId: string, opts: { agent: number }) => {
      await wrap(`${commandPrefix} exec`, ctx, async () => {
        await requireInitialized(ctx.getRoot());
        return execPreflightAgent(ctx.getRoot(), runId, opts);
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
        return attachPreflightReport(ctx.getRoot(), runId, opts);
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
        return pullPreflightRun(ctx.getRoot(), runId, {
          source: opts.source,
          before: opts.before,
          limit: opts.limit,
          allowOverlap: ctx.assumeYes(),
        });
      });
    });

  preflight
    .command('complete <run_id>')
    .description('Mark a preflight run as completed.')
    .action(async (runId: string) => {
      await wrap(`${commandPrefix} complete`, ctx, async () => {
        await requireInitialized(ctx.getRoot());
        return completePreflightRun(ctx.getRoot(), runId);
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
        return completeLocalPreflightRun(ctx.getRoot(), runId, opts);
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
        return dryRunPreflight(ctx.getRoot(), experimentId, opts);
      });
    });

  preflight
    .command('audit <run_id>')
    .description('Create a launch-readiness audit for a preflight run.')
    .option('--markdown', 'Print markdown instead of JSON data.')
    .action(async (runId: string, opts: { markdown?: boolean }) => {
      await wrap(`${commandPrefix} audit`, ctx, async () => {
        await requireInitialized(ctx.getRoot());
        return auditPreflightRun(ctx.getRoot(), runId, opts);
      });
    });
}
