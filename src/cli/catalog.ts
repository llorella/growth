import type { Command } from 'commander';
import { wrap, type RunCtx } from '../lib/runner.js';
import { CATALOG } from '../lib/defaults.js';
import { GrowthError } from '../lib/envelope.js';

const CATALOGS: Record<string, unknown> = {
  connectors: CATALOG.connectors,
  templates: CATALOG.templates,
  metrics: CATALOG.metric_archetypes,
  workflows: CATALOG.workflows,
  example_events: [
    'experiment_viewed',
    'primary_goal_completed',
    'guardrail_condition_observed',
  ],
};

export function registerCatalog(program: Command, ctx: RunCtx): void {
  program
    .command('catalog')
    .description('List example connector, template, event, metric, and workflow identifiers.')
    .argument('[name]', 'connectors, templates, example_events, metrics, or workflows')
    .action(async (name?: string) => {
      await wrap('growth catalog', ctx, async () => {
        if (!name) {
          return {
            data: CATALOGS,
            humanText: JSON.stringify(CATALOGS, null, 2),
          };
        }
        const data = CATALOGS[name];
        if (!data) {
          throw new GrowthError('catalog_not_found', `Unknown catalog "${name}".`, {
            available: Object.keys(CATALOGS),
          });
        }
        return {
          data: { [name]: data },
          humanText: JSON.stringify(data, null, 2),
        };
      });
    });
}
