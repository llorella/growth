import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { Experiment } from '../../core/experiment/types.js';
import { containsTimestamp } from '../../core/evidence/event-window.js';
import { requiredConnectorEvents } from '../../lib/connector-catalog.js';
import type { ConnectorConfig } from '../../lib/connectors.js';
import { GrowthError } from '../../lib/envelope.js';
import { providerCapabilityPolicy } from '../auth-policy.js';
import { mapConnectorEvent, readConnectorPath } from '../mapping.js';
import { defaultLocalConnector } from './config.js';
import type {
  ConnectorAdapter,
  ConnectorCapabilityStatus,
  ConnectorDefaultConfigInput,
  ConnectorPullWindow,
} from '../types.js';

export const localAdapter: ConnectorAdapter = {
  kind: 'native-app',
  defaultSource: 'local',
  sourceAliases: ['local', 'native-app'],
  importProviders: [],
  evidenceSource: 'local_jsonl',
  providerBacked: false,

  defaultConfig(input: ConnectorDefaultConfigInput): ConnectorConfig {
    return defaultLocalConnector(input.eventsFile ?? 'tmp/events.jsonl');
  },

  requiredEnv(): string[] {
    return [];
  },

  requiredScopes(): string[] {
    return [];
  },

  authEnv(): string | undefined {
    return undefined;
  },

  mappedEvents(connector: ConnectorConfig): string[] {
    return Object.entries(connector.mappings).map(([sourceEvent, rule]) => rule.framework_event ?? sourceEvent);
  },

  validateConfig(connector: ConnectorConfig) {
    return !isRecord(connector.local) || typeof connector.local.events_file !== 'string' || connector.local.events_file.length === 0
      ? [{ source: connector.source, message: 'missing local.events_file', path: 'local.events_file' }]
      : [];
  },

  async capabilityStatus(_root: string, connector: ConnectorConfig): Promise<ConnectorCapabilityStatus> {
    return {
      source: connector.source,
      kind: connector.kind,
      provider_backed: false,
      capabilities: {
        local_synthetic: {
          ready: !!connector.local?.events_file,
          missing: connector.local?.events_file ? [] : ['events_file'],
        },
      },
    };
  },

  coverage(connector: ConnectorConfig, experiment: Experiment): boolean {
    const mapped = new Set(this.mappedEvents(connector));
    return requiredConnectorEvents(experiment).every((event) => mapped.has(event));
  },

  async authCheck(_root: string, connector: ConnectorConfig) {
    return {
      data: {
        source: connector.source,
        kind: connector.kind,
        auth_required: false,
        required_scopes: [],
      },
      humanText: `${connector.source} auth: not required`,
      nextSteps: [`growth connector validate ${connector.source} --json`],
    };
  },

  async authSetup(_root: string, connector: ConnectorConfig) {
    return {
      data: {
        source: connector.source,
        kind: connector.kind,
        ready: true,
        resolution: 'ready',
        blocked: false,
        manual_input_required: false,
        safe_commands: [],
        retry_command: `growth connector auth check ${connector.source} --json`,
        auth_required: false,
        missing_requirements: [],
        policy: providerCapabilityPolicy(),
      },
      humanText: `${connector.source} auth setup: not required`,
      nextSteps: [`growth connector validate ${connector.source} --json`],
      next: {
        command: `growth connector validate ${connector.source} --json`,
        until: 'connector mappings validate against active experiments',
      },
    };
  },

  mapEvent(connector: ConnectorConfig, raw: unknown) {
    return mapConnectorEvent(connector, raw);
  },

  async pullEvents(
    root: string,
    connector: ConnectorConfig,
    window: ConnectorPullWindow,
    limit: number,
  ): Promise<unknown[]> {
    return fetchLocalJsonl(root, connector, window, limit);
  },

  providerPullBlockReason(connector: ConnectorConfig): string {
    return `${connector.source} does not support provider-backed pulls.`;
  },

  providerPullBlockedWhy(): string {
    return 'Local JSONL can validate synthetic app emission only; it does not prove provider ingestion.';
  },

  coverageBlockedWhy(connector: ConnectorConfig): string {
    return `${connector.source} mappings do not cover every event required by this experiment.`;
  },

  readyWhy(): string {
    return 'No provider-backed analytics source is configured; local JSONL is the available synthetic validation path.';
  },
};

async function fetchLocalJsonl(
  root: string,
  connector: ConnectorConfig,
  window: ConnectorPullWindow,
  limit: number,
): Promise<unknown[]> {
  const configuredFile = connector.local?.events_file;
  if (!configuredFile) {
    throw new GrowthError(
      'connector_misconfigured',
      'native-app local pull requires local.events_file in the connector config.',
    );
  }
  const file = path.isAbsolute(configuredFile) ? configuredFile : path.join(root, configuredFile);
  let raw: string;
  try {
    raw = await fs.readFile(file, 'utf8');
  } catch {
    throw new GrowthError(
      'local_events_file_not_found',
      `Local events file not found: ${path.relative(root, file)}`,
      { file: path.relative(root, file) },
    );
  }

  const out: unknown[] = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    const timestamp = connector.timestamp_path
      ? readConnectorPath(parsed, connector.timestamp_path)
      : readConnectorPath(parsed, 'timestamp');
    const timestampCheck = containsTimestamp(
      window,
      typeof timestamp === 'string' ? timestamp : undefined,
    );
    if (!timestampCheck.inside) continue;
    out.push(parsed);
    if (out.length >= limit) break;
  }
  return out;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
