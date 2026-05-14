import type { Command } from 'commander';
import { wrap, type RunCtx } from '../lib/runner.js';
import {
  connectorSchema,
  eventTaxonomySchema,
  experimentSchema,
  preflightReportSchema,
} from '../core/experiment/schema.js';
import { GrowthError } from '../lib/envelope.js';

const SCHEMAS: Record<string, unknown> = {
  experiment: experimentSchema,
  connector: connectorSchema,
  'event-taxonomy': eventTaxonomySchema,
  'preflight-report': preflightReportSchema,
};

export function registerSchema(program: Command, ctx: RunCtx): void {
  program
    .command('schema')
    .description('Print a growth JSON Schema.')
    .argument('<name>', 'experiment, connector, event-taxonomy, or preflight-report')
    .action(async (name: string) => {
      await wrap('growth schema', ctx, async () => {
        const schema = SCHEMAS[name];
        if (!schema) {
          throw new GrowthError('schema_not_found', `Unknown schema "${name}".`, {
            available: Object.keys(SCHEMAS),
          });
        }
        return {
          data: { name, schema: schema as Record<string, unknown> },
          humanText: JSON.stringify(schema, null, 2),
        };
      });
    });
}
