import type { Command } from 'commander';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { wrap, type RunCtx } from '../lib/runner.js';
import { requireInitialized } from '../lib/gating.js';
import { Store } from '../lib/store.js';
import { GrowthError } from '../lib/envelope.js';
import { paths } from '../lib/paths.js';

export function registerTemplates(program: Command, ctx: RunCtx): void {
  const template = program
    .command('template')
    .alias('templates')
    .description('List and inspect experiment templates.');

  template
    .command('list')
    .description('List available templates.')
    .action(async () => {
      await wrap('growth template list', ctx, async () => {
        await requireInitialized(ctx.getRoot());
        const store = new Store(ctx.getRoot());
        const names = await store.listTemplates();
        const sources = Object.fromEntries(
          await Promise.all(names.map(async (name) => [name, await templateSource(ctx.getRoot(), name)])),
        );
        return {
          data: { templates: names, sources },
          humanText:
            names.length === 0
              ? 'No templates installed. Run `growth init --json`.'
              : names.map((n) => `  ${n} (${sources[n]})`).join('\n'),
        };
      });
    });

  template
    .command('show <name>')
    .description('Show one template.')
    .action(async (name: string) => {
      await wrap('growth template show', ctx, async () => {
        await requireInitialized(ctx.getRoot());
        const store = new Store(ctx.getRoot());
        const t = await store.getTemplate(name);
        if (!t) throw new GrowthError('not_found', `Template "${name}" not found.`);
        const source = await templateSource(ctx.getRoot(), name);
        return {
          data: {
            template: t,
            source,
            note:
              source === 'built-in'
                ? 'Built-in templates are available through growth template show/list and are not copied into .growth/templates by default.'
                : undefined,
          },
          humanText: JSON.stringify(t, null, 2),
        };
      });
    });
}

async function templateSource(root: string, name: string): Promise<'local' | 'built-in'> {
  try {
    await fs.access(path.join(paths(root).templatesDir, `${name}.json`));
    return 'local';
  } catch {
    return 'built-in';
  }
}
