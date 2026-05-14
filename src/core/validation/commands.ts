import { promises as fs } from 'node:fs';
import { assertConnectorCoverage } from '../../connectors/coverage.js';
import { listConnectors } from '../../connectors/persistence.js';
import { GrowthError } from '../../lib/envelope.js';
import { paths } from '../../lib/paths.js';
import { Store } from '../../lib/store.js';

export async function validateProjectCommand(root: string) {
  const store = new Store(root);
  const experiments = await store.listExperiments();
  const connectors = await listConnectors(root);
  const warnings = [];
  for (const exp of experiments) {
    await store.saveExperiment(exp);
  }
  try {
    assertConnectorCoverage(experiments, connectors);
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
}
