import type { Command } from 'commander';
import { wrap, type RunCtx } from '../lib/runner.js';
import { CATALOG } from '../lib/defaults.js';
import { GrowthError } from '../lib/envelope.js';

const CATALOGS: Record<string, unknown> = {
  connectors: CATALOG.connectors,
  templates: CATALOG.templates,
  metrics: CATALOG.metric_archetypes,
  workflows: CATALOG.workflows,
  events: [
    'experiment_viewed',
    'conversion_completed',
    'onboarding_started',
    'onboarding_completed',
    'activation_completed',
    'onboarding_error',
    'pricing_viewed',
    'checkout_completed',
    'refund_requested',
    'cross_sell_presented',
    'cross_sell_accepted',
  ],
};

export function registerCatalog(program: Command, ctx: RunCtx): void {
  program
    .command('catalog')
    .description('List known connector, template, event, metric, and workflow identifiers.')
    .argument('[name]', 'connectors, templates, events, metrics, or workflows')
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
