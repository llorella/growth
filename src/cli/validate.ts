import type { Command } from 'commander';
import { wrap, type RunCtx } from '../lib/runner.js';
import { requireInitialized } from '../lib/gating.js';
import { validateProjectCommand } from '../core/validation/commands.js';

export function registerValidate(program: Command, ctx: RunCtx): void {
  program
    .command('validate')
    .description('Validate growth experiment configs, connector coverage, and event taxonomy.')
    .action(async () => {
      await wrap('growth validate', ctx, async () => {
        const root = ctx.getRoot();
        await requireInitialized(root);
        return validateProjectCommand(root);
      });
    });
}
