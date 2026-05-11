import type { Command } from 'commander';
import { promises as fs } from 'node:fs';
import { wrap, type RunCtx } from '../lib/runner.js';
import { requireInitialized } from '../lib/gating.js';
import { Store } from '../lib/store.js';
import { listConnectors, assertCoverage } from '../lib/connectors.js';
import { paths } from '../lib/paths.js';
import { GrowthError } from '../lib/envelope.js';

export function registerValidate(program: Command, ctx: RunCtx): void {
  program
    .command('validate')
    .description('Validate growth experiment configs, connector coverage, and event taxonomy.')
    .action(async () => {
      await wrap('growth validate', ctx, async () => {
        await requireInitialized(ctx.getRoot());
        const root = ctx.getRoot();
        const store = new Store(root);
        const experiments = await store.listExperiments();
        const connectors = await listConnectors(root);
        const warnings = [];
        for (const exp of experiments) {
          await store.saveExperiment(exp);
        }
        try {
          assertCoverage(experiments, connectors);
        } catch (err) {
          warnings.push({
            code: 'CONNECTOR_COVERAGE_GAP',
            message: err instanceof Error ? err.message : String(err),
          });
        }
        try {
          JSON.parse(await fs.readFile(paths(root).eventTaxonomyFile, 'utf8'));
        } catch {
          warnings.push({
            code: 'EVENT_TAXONOMY_INVALID',
            message: '.growth/event-taxonomy.json is missing or invalid JSON.',
          });
        }
        if (warnings.length > 0) {
          throw new GrowthError('validation_failed', `Validation failed with ${warnings.length} warning(s).`, {
            ok: false,
            experiments: experiments.length,
            connectors: connectors.length,
            warnings,
          });
        }
        return {
          data: {
            ok: true,
            experiments: experiments.length,
            connectors: connectors.length,
            warnings,
          },
          warnings,
          humanText: `Validation OK across ${experiments.length} experiment(s).`,
        };
      });
    });
}
