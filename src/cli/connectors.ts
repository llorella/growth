import type { Command } from 'commander';
import { wrap, type RunCtx } from '../lib/runner.js';
import { requireInitialized } from '../lib/gating.js';
import {
  addConnectorCommand,
  checkConnectorAuthCommand,
  importConnectorCommand,
  listConnectorCommand,
  setupConnectorAuthCommand,
  showConnectorCommand,
  validateConnectorCommand,
} from '../connectors/commands.js';

export function registerConnectors(program: Command, ctx: RunCtx): void {
  const connector = program
    .command('connector')
    .alias('connectors')
    .description('Manage data-source connectors.');

  connector
    .command('list')
    .description('List installed connectors.')
    .action(async () => {
      await wrap('growth connector list', ctx, async () => {
        const root = ctx.getRoot();
        await requireInitialized(root);
        return listConnectorCommand(root);
      });
    });

  connector
    .command('add <source>')
    .description('Create a connector config.')
    .option('--project-id <id>', 'Optional provider project id or env var name for read/pull APIs.')
    .option('--host <url>', 'Provider host URL.')
    .option('--api-key-env <name>', 'Environment variable containing the telemetry API key.')
    .option('--events-file <path>', 'Local JSONL event stream for `local` connectors.', 'tmp/events.jsonl')
    .option('--from-stripe-projects', 'Import PostHog connector metadata from Stripe Projects context.', false)
    .action(async (source: string, opts: { projectId?: string; host?: string; apiKeyEnv?: string; eventsFile: string; fromStripeProjects?: boolean }) => {
      await wrap('growth connector add', ctx, async () => {
        const root = ctx.getRoot();
        await requireInitialized(root);
        return addConnectorCommand(root, source, {
          projectId: opts.projectId,
          host: opts.host,
          apiKeyEnv: opts.apiKeyEnv,
          eventsFile: opts.eventsFile,
          fromStripeProjects: opts.fromStripeProjects,
          overwrite: ctx.assumeYes(),
        });
      });
    });

  connector
    .command('import <provider>')
    .description('Import connector metadata from another deterministic provider context.')
    .action(async (provider: string) => {
      await wrap('growth connector import', ctx, async () => {
        const root = ctx.getRoot();
        await requireInitialized(root);
        return importConnectorCommand(root, provider, { overwrite: ctx.assumeYes() });
      });
    });

  connector
    .command('show <source>')
    .description('Show one connector config.')
    .action(async (source: string) => {
      await wrap('growth connector show', ctx, async () => {
        const root = ctx.getRoot();
        await requireInitialized(root);
        return showConnectorCommand(root, source);
      });
    });

  connector
    .command('validate [source]')
    .alias('check')
    .description('Validate connector shape and field coverage against active experiments.')
    .action(async (source?: string) => {
      await wrap('growth connector validate', ctx, async () => {
        const root = ctx.getRoot();
        await requireInitialized(root);
        return validateConnectorCommand(root, source);
      });
    });

  const auth = connector.command('auth').description('Connector provider capability helpers.');
  auth
    .command('check <source>')
    .description('Check connector telemetry and provider-pull readiness without printing secrets.')
    .action(async (source: string) => {
      await wrap<unknown>('growth connector auth check', ctx, async () => {
        const root = ctx.getRoot();
        await requireInitialized(root);
        return checkConnectorAuthCommand(root, source);
      });
    });

  auth
    .command('setup <source>')
    .description('Explain safe setup steps for provider capabilities without printing secrets.')
    .action(async (source: string) => {
      await wrap<unknown>('growth connector auth setup', ctx, async () => {
        const root = ctx.getRoot();
        await requireInitialized(root);
        return setupConnectorAuthCommand(root, source);
      });
    });
}
