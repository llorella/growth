import path from 'node:path';
import { assertConnectorCoverage } from './coverage.js';
import { addConnectorFromSource } from './add.js';
import {
  importConnectorFromProvider,
  importConnectorFromProviderForSource,
} from './import.js';
import { connectorAdapterFor } from './registry.js';
import { GrowthError } from '../lib/envelope.js';
import {
  readConnector,
  listConnectors,
  validateConnectorConfig,
} from './persistence.js';
import type { ConnectorConfig } from './types.js';
import { Store } from '../lib/store.js';

export interface AddConnectorCommandOptions {
  projectId?: string;
  host?: string;
  apiKeyEnv?: string;
  eventsFile: string;
  fromStripeProjects?: boolean;
  overwrite?: boolean;
}

export async function listConnectorCommand(root: string) {
  const all = await listConnectors(root);
  return {
    data: {
      connectors: all.map((c) => ({
        source: c.source,
        kind: c.kind,
        mapped_events: Object.keys(c.mappings).length,
      })),
    },
    humanText:
      all.length === 0
        ? 'No connectors installed. Run `growth connector add posthog --json`.'
        : all
            .map(
              (c) =>
                `  ${c.source.padEnd(20)} ${c.kind.padEnd(12)} ${Object.keys(c.mappings).length} mappings`,
            )
            .join('\n'),
  };
}

export async function addConnectorCommand(root: string, source: string, opts: AddConnectorCommandOptions) {
  if (opts.fromStripeProjects) {
    return importConnectorCommand(root, 'stripe-projects', {
      source,
      overwrite: opts.overwrite,
    });
  }

  const added = await addConnectorFromSource(root, source, {
    projectId: opts.projectId,
    host: opts.host,
    apiKeyEnv: opts.apiKeyEnv,
    eventsFile: opts.eventsFile,
  });
  return {
    data: { connector: added.connector, file: added.file },
    humanText: `Created ${added.source} connector at ${added.file}.`,
    nextSteps: added.adapter.providerBacked
      ? [
          `Map experiment events in ${path.relative(root, added.file)}.`,
          `growth connector auth check ${added.source} --json`,
          `growth connector validate ${added.source} --json`,
        ]
      : [
          `Write app-emitted JSONL events to ${opts.eventsFile}.`,
          `growth connector validate ${added.source} --json`,
          `growth pull <experiment_id> --source ${added.source} --json`,
        ],
  };
}

export async function importConnectorCommand(
  root: string,
  provider: string,
  opts: { source?: string; overwrite?: boolean } = {},
) {
  const importOpts = { overwrite: opts.overwrite === true };
  const imported = opts.source
    ? await importConnectorFromProviderForSource(root, opts.source, provider, importOpts)
    : await importConnectorFromProvider(root, provider, importOpts);
  return {
    data: { connector: imported.connector, file: imported.file, imported_from: imported.imported_from },
    humanText: `Imported ${imported.source} connector from ${provider} metadata at ${imported.imported_from}.`,
    nextSteps: [
      `growth connector auth check ${imported.source} --json`,
      `growth connector validate ${imported.source} --json`,
    ],
    next: {
      command: `growth connector auth check ${imported.source} --json`,
      until: `${imported.source} connector auth is ready without exposing secrets`,
    },
  };
}

export async function showConnectorCommand(root: string, source: string) {
  const c = await readConnector(root, source);
  if (!c) throw new GrowthError('not_found', `Connector "${source}" not found.`);
  return { data: { connector: c }, humanText: JSON.stringify(c, null, 2) };
}

export async function validateConnectorCommand(root: string, source?: string) {
  const store = new Store(root);
  const [experiments, connectors] = await Promise.all([
    store.listExperiments(),
    listConnectors(root),
  ]);
  if (source && !connectors.some((c) => c.source === source)) {
    throw new GrowthError('not_found', `Connector "${source}" not found.`);
  }
  const selectedConnectors = source ? connectors.filter((c) => c.source === source) : connectors;
  validateConnectorShapes(selectedConnectors);
  assertConnectorCoverage(experiments, selectedConnectors);
  return {
    data: {
      ok: true,
      experiments: experiments.length,
      connectors: selectedConnectors.length,
    },
    humanText: `Coverage OK across ${experiments.length} experiment(s) and ${selectedConnectors.length} connector(s).`,
  };
}

export async function checkConnectorAuthCommand(root: string, source: string) {
  const c = await readConnector(root, source);
  if (!c) throw new GrowthError('not_found', `Connector "${source}" not found.`);
  const adapter = connectorAdapterFor(c);
  if (!adapter) {
    throw new GrowthError('unsupported_connector', `Connector kind "${c.kind}" does not support auth helpers.`);
  }
  return adapter.authCheck(root, c);
}

export async function setupConnectorAuthCommand(root: string, source: string) {
  const c = await readConnector(root, source);
  if (!c) throw new GrowthError('not_found', `Connector "${source}" not found.`);
  const adapter = connectorAdapterFor(c);
  if (!adapter) {
    throw new GrowthError('unsupported_connector', `Connector kind "${c.kind}" does not support auth helpers.`);
  }
  return adapter.authSetup(root, c);
}

function validateConnectorShapes(connectors: ConnectorConfig[]): void {
  const errors = connectors.flatMap(validateConnectorConfig);
  if (errors.length) {
    throw new GrowthError('invalid_connector', 'Connector validation failed.', { errors });
  }
}
