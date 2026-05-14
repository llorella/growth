import type { Experiment } from '../../core/experiment/types.js';
import {
  defaultTaxonomyMappings,
  envProjectIds,
  isEnvReference,
  requiredConnectorEvents,
} from '../../lib/connector-catalog.js';
import type { ConnectorConfig } from '../../lib/connectors.js';
import { readEnvValue } from '../../lib/env-files.js';
import { GrowthError } from '../../lib/envelope.js';
import { providerCapabilityPolicy } from '../auth-policy.js';
import { mapConnectorEvent } from '../mapping.js';
import type {
  ConnectorAdapter,
  ConnectorCapabilityStatus,
  ConnectorDefaultConfigInput,
  ConnectorPullWindow,
} from '../types.js';

const STATSIG_DEFAULT_API_URL = 'https://statsigapi.net';
const STATSIG_DEFAULT_SERVER_KEY_ENV = 'STATSIG_SERVER_SECRET';
const STATSIG_DEFAULT_CONSOLE_API_KEY_ENV = 'STATSIG_CONSOLE_API_KEY';
const STATSIG_DEFAULT_PROJECT_ID = 'STATSIG_PROJECT_ID';

export const statsigAdapter: ConnectorAdapter = {
  kind: 'statsig',
  defaultSource: 'statsig',
  sourceAliases: ['statsig'],
  importProviders: [],
  evidenceSource: 'statsig',
  providerBacked: true,

  defaultConfig(input: ConnectorDefaultConfigInput): ConnectorConfig {
    return {
      source: 'statsig',
      kind: 'statsig',
      user_id_path: 'user.userID',
      anonymous_id_path: 'user.customIDs.anonymousID',
      experiment_id_path: 'metadata.experiment_id',
      variant_id_path: 'metadata.variant_id',
      event_name_path: 'eventName',
      timestamp_path: 'time',
      idempotency_key_path: 'metadata.event_id',
      statsig: {
        api_url: input.host ?? STATSIG_DEFAULT_API_URL,
        server_key_env: input.apiKeyEnv ?? STATSIG_DEFAULT_SERVER_KEY_ENV,
        console_api_key_env: input.consoleApiKeyEnv ?? STATSIG_DEFAULT_CONSOLE_API_KEY_ENV,
        project_id: input.projectId ?? STATSIG_DEFAULT_PROJECT_ID,
      },
      mappings: input.mappings ?? defaultStatsigMappings(),
    };
  },

  requiredEnv(connector: ConnectorConfig): string[] {
    return [
      statsigServerKeyEnv(connector),
      statsigConsoleApiKeyEnv(connector),
      ...envProjectIds(connector.statsig?.project_id),
    ].filter((value): value is string => !!value);
  },

  requiredScopes(): string[] {
    return [];
  },

  authEnv(connector: ConnectorConfig): string | undefined {
    return statsigServerKeyEnv(connector);
  },

  mappedEvents(connector: ConnectorConfig): string[] {
    return Object.entries(connector.mappings).map(([sourceEvent, rule]) => rule.framework_event ?? sourceEvent);
  },

  validateConfig(connector: ConnectorConfig) {
    const issues = [];
    if (!isRecord(connector.statsig)) {
      issues.push({ source: connector.source, message: 'missing statsig config block', path: 'statsig' });
    } else {
      if (connector.statsig.api_url !== undefined && typeof connector.statsig.api_url !== 'string') {
        issues.push({ source: connector.source, message: 'statsig.api_url must be a string', path: 'statsig.api_url' });
      }
      if (
        connector.statsig.project_id !== undefined &&
        typeof connector.statsig.project_id !== 'string' &&
        typeof connector.statsig.project_id !== 'number'
      ) {
        issues.push({ source: connector.source, message: 'statsig.project_id must be a string or number', path: 'statsig.project_id' });
      }
      if (connector.statsig.server_key_env !== undefined && typeof connector.statsig.server_key_env !== 'string') {
        issues.push({ source: connector.source, message: 'statsig.server_key_env must be a string', path: 'statsig.server_key_env' });
      }
      if (connector.statsig.console_api_key_env !== undefined && typeof connector.statsig.console_api_key_env !== 'string') {
        issues.push({ source: connector.source, message: 'statsig.console_api_key_env must be a string', path: 'statsig.console_api_key_env' });
      }
    }
    return issues;
  },

  async capabilityStatus(root: string, connector: ConnectorConfig): Promise<ConnectorCapabilityStatus> {
    const status = await statsigCapabilityStatus(root, connector);
    return {
      source: connector.source,
      kind: connector.kind,
      provider_backed: true,
      capabilities: status.capabilities,
      setup_command: `growth connector auth setup ${connector.source} --json`,
    };
  },

  coverage(connector: ConnectorConfig, experiment: Experiment): boolean {
    const mapped = new Set(this.mappedEvents(connector));
    return requiredConnectorEvents(experiment).every((event) => mapped.has(event));
  },

  async authCheck(root: string, connector: ConnectorConfig) {
    const status = await statsigCapabilityStatus(root, connector);
    const ready = status.capabilities.provider_pull.ready;
    return {
      data: status,
      humanText: `${connector.source} capabilities: telemetry_write=${status.capabilities.telemetry_write.ready ? 'ready' : 'blocked'} provider_pull=${ready ? 'ready' : 'blocked'}`,
      nextSteps: ready
        ? [`growth connector validate ${connector.source} --json`]
        : [`growth connector auth setup ${connector.source} --json`],
      next: ready
        ? {
            command: `growth connector validate ${connector.source} --json`,
            until: 'connector mappings validate against active experiments',
          }
        : {
            command: `growth connector auth setup ${connector.source} --json`,
            until: 'missing provider-pull requirements are resolved through Growth',
          },
    };
  },

  async authSetup(root: string, connector: ConnectorConfig) {
    const status = await statsigCapabilityStatus(root, connector);
    const ready = status.capabilities.provider_pull.ready;
    const missingRequirements = statsigMissingRequirements(connector, status);
    return {
      data: {
        source: connector.source,
        kind: connector.kind,
        ready,
        resolution: ready ? 'ready' : 'manual_input_required',
        blocked: !ready,
        manual_input_required: !ready && missingRequirements.some((requirement) => requirement.manual_input_required),
        safe_commands: missingRequirements.flatMap((requirement) => requirement.safe_commands),
        retry_command: `growth connector auth check ${connector.source} --json`,
        ...(!ready
          ? {
              stop_reason:
                'Provider-backed evidence setup requires manual read-side values. Stop automated provider preflight until the missing values are supplied through Growth commands.',
            }
          : {}),
        telemetry_write_ready: status.capabilities.telemetry_write.ready,
        provider_pull_ready: status.capabilities.provider_pull.ready,
        status,
        missing_requirements: missingRequirements,
        policy: providerCapabilityPolicy(),
      },
      humanText: ready
        ? `${connector.source} auth setup: ready`
        : `${connector.source} provider pull setup: missing ${status.capabilities.provider_pull.missing.join(', ')}`,
      nextSteps: ready
        ? [`growth connector validate ${connector.source} --json`]
        : [
            'Stop automated provider-backed preflight until the missing read-side values are supplied.',
            'Manual input required: supply missing provider-pull values through Growth env commands.',
            'Do not read .env files or call analytics provider APIs directly.',
          ],
      next: ready
        ? {
            command: `growth connector validate ${connector.source} --json`,
            until: 'connector mappings validate against active experiments',
          }
        : undefined,
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
    return fetchStatsig(root, connector, window, limit);
  },

  providerPullBlockReason(connector: ConnectorConfig, status: ConnectorCapabilityStatus): string {
    return `${connector.source} provider-backed preflight is blocked because required Statsig read-side values are missing: ${status.capabilities.provider_pull?.missing.join(', ') ?? 'unknown'}.`;
  },

  providerPullBlockedWhy(status: ConnectorCapabilityStatus): string {
    return status.capabilities.telemetry_write?.ready
      ? 'Statsig app telemetry is configured, but provider-backed evidence pull is not ready.'
      : 'A Statsig connector is configured, but telemetry and provider-backed evidence are not ready.';
  },

  coverageBlockedWhy(): string {
    return 'A provider-backed Statsig connector is configured and auth is ready, but mappings do not cover the experiment events.';
  },

  readyWhy(): string {
    return 'Provider-backed Statsig evidence is configured and should validate synthetic preflight ingestion.';
  },
};

interface StatsigCapabilityStatus {
  capabilities: {
    telemetry_write: { ready: boolean; missing: string[]; required_env: string[] };
    provider_pull: { ready: boolean; missing: string[]; required_env: string[] };
  };
  server_key_env: string;
  console_api_key_env: string;
  project_id_env?: string;
  server_key_present: boolean;
  console_api_key_present: boolean;
  project_id_present: boolean;
}

interface StatsigAuthRequirement {
  id: string;
  capability: 'telemetry_write' | 'provider_pull';
  field: 'server_key' | 'console_api_key' | 'project_id';
  env?: string;
  present: boolean;
  manual_input_required: boolean;
  safe_commands: string[];
  guidance: string;
}

async function statsigCapabilityStatus(root: string, connector: ConnectorConfig): Promise<StatsigCapabilityStatus> {
  const serverKeyEnv = statsigServerKeyEnv(connector);
  const consoleApiKeyEnv = statsigConsoleApiKeyEnv(connector);
  const projectId = connector.statsig?.project_id;
  const projectIdEnv = isEnvReference(projectId) ? projectId : undefined;
  const [serverKey, consoleApiKey, projectIdValue] = await Promise.all([
    serverKeyEnv ? readEnvValue(root, serverKeyEnv) : Promise.resolve(undefined),
    consoleApiKeyEnv ? readEnvValue(root, consoleApiKeyEnv) : Promise.resolve(undefined),
    projectIdEnv ? readEnvValue(root, projectIdEnv) : Promise.resolve(undefined),
  ]);
  const serverKeyPresent = !!serverKey;
  const consoleApiKeyPresent = !!consoleApiKey;
  const projectIdPresent =
    projectId !== undefined && (projectIdEnv ? !!projectIdValue : String(projectId).trim().length > 0);
  const providerMissing = [
    ...(consoleApiKeyPresent ? [] : ['console_api_key']),
    ...(projectIdPresent ? [] : ['project_id']),
  ];
  return {
    capabilities: {
      telemetry_write: {
        ready: serverKeyPresent,
        missing: serverKeyPresent ? [] : ['server_key'],
        required_env: serverKeyEnv ? [serverKeyEnv] : [],
      },
      provider_pull: {
        ready: consoleApiKeyPresent && projectIdPresent,
        missing: providerMissing,
        required_env: [consoleApiKeyEnv, projectIdEnv].filter((value): value is string => !!value),
      },
    },
    server_key_env: serverKeyEnv ?? STATSIG_DEFAULT_SERVER_KEY_ENV,
    console_api_key_env: consoleApiKeyEnv ?? STATSIG_DEFAULT_CONSOLE_API_KEY_ENV,
    ...(projectIdEnv ? { project_id_env: projectIdEnv } : {}),
    server_key_present: serverKeyPresent,
    console_api_key_present: consoleApiKeyPresent,
    project_id_present: projectIdPresent,
  };
}

function statsigMissingRequirements(
  connector: ConnectorConfig,
  status: StatsigCapabilityStatus,
): StatsigAuthRequirement[] {
  const requirements: StatsigAuthRequirement[] = [];
  if (!status.server_key_present) {
    requirements.push({
      id: 'statsig-server-key',
      capability: 'telemetry_write',
      field: 'server_key',
      env: status.server_key_env,
      present: false,
      manual_input_required: true,
      safe_commands: status.server_key_env ? [`growth env set --key ${status.server_key_env} --stdin`] : [],
      guidance: status.server_key_env
        ? `Provide the Statsig server secret through growth env set for ${status.server_key_env}.`
        : 'Configure statsig.server_key_env on the connector, then rerun auth setup.',
    });
  }
  if (!status.console_api_key_present) {
    requirements.push({
      id: 'statsig-console-api-key',
      capability: 'provider_pull',
      field: 'console_api_key',
      env: status.console_api_key_env,
      present: false,
      manual_input_required: true,
      safe_commands: status.console_api_key_env ? [`growth env set --key ${status.console_api_key_env} --stdin`] : [],
      guidance: status.console_api_key_env
        ? `Provide the Statsig Console API key through growth env set for ${status.console_api_key_env}.`
        : 'Configure statsig.console_api_key_env on the connector, then rerun auth setup.',
    });
  }
  if (!status.project_id_present) {
    requirements.push({
      id: 'statsig-provider-pull-project-id',
      capability: 'provider_pull',
      field: 'project_id',
      env: status.project_id_env,
      present: false,
      manual_input_required: true,
      safe_commands: status.project_id_env ? [`growth env set --key ${status.project_id_env} --stdin`] : [],
      guidance: status.project_id_env
        ? `Provide the Statsig project id through growth env set for ${status.project_id_env}.`
        : 'Set statsig.project_id to an env var name or project id, then rerun auth setup.',
    });
  }
  if (connector.statsig?.project_id === undefined) {
    requirements.push({
      id: 'statsig-project-id-config',
      capability: 'provider_pull',
      field: 'project_id',
      present: false,
      manual_input_required: false,
      safe_commands: [],
      guidance: 'Set statsig.project_id on the connector config, then rerun auth setup.',
    });
  }
  return requirements;
}

function statsigServerKeyEnv(connector: ConnectorConfig): string | undefined {
  return connector.statsig?.server_key_env ?? STATSIG_DEFAULT_SERVER_KEY_ENV;
}

function statsigConsoleApiKeyEnv(connector: ConnectorConfig): string | undefined {
  return connector.statsig?.console_api_key_env ?? STATSIG_DEFAULT_CONSOLE_API_KEY_ENV;
}

function defaultStatsigMappings(): ConnectorConfig['mappings'] {
  return Object.fromEntries(
    Object.entries(defaultTaxonomyMappings({ includeFrameworkEvent: false })).map(([event, mapping]) => [
      event,
      {
        ...mapping,
        payload_paths: Object.fromEntries(
          Object.entries(mapping.payload_paths ?? {}).map(([key, value]) => [
            key,
            value.replace(/^properties\./, 'metadata.'),
          ]),
        ),
      },
    ]),
  );
}

async function fetchStatsig(
  root: string,
  connector: ConnectorConfig,
  window: ConnectorPullWindow,
  limit: number,
): Promise<unknown[]> {
  if (!connector.statsig) {
    throw new GrowthError(
      'connector_misconfigured',
      'statsig connector is missing the `statsig` config block (api_url, project_id, console_api_key_env).',
    );
  }
  const consoleApiKeyEnv = statsigConsoleApiKeyEnv(connector) ?? STATSIG_DEFAULT_CONSOLE_API_KEY_ENV;
  const consoleApiKey = await readEnvValue(root, consoleApiKeyEnv);
  if (!consoleApiKey) {
    throw new GrowthError(
      'missing_statsig_console_api_key',
      `Set ${consoleApiKeyEnv} to the Statsig Console API key configured for this project.`,
    );
  }
  const configuredProjectId = connector.statsig.project_id ?? STATSIG_DEFAULT_PROJECT_ID;
  const projectId = await readStatsigProviderProjectId(root, connector);
  if (!projectId) {
    throw new GrowthError(
      'missing_statsig_project_id',
      `Statsig provider pulls require a project id. Set ${String(configuredProjectId)} before running provider-backed preflight.`,
    );
  }

  const apiUrl = connector.statsig.api_url ?? STATSIG_DEFAULT_API_URL;
  const eventNames = Object.keys(connector.mappings);
  const results: unknown[] = [];
  const maxPagesPerEvent = 25;
  for (const eventName of eventNames) {
    let page = 1;
    let url: string | null = statsigEventsUrl(apiUrl, eventName, { page, limit });
    while (url && page <= maxPagesPerEvent && results.length < limit * eventNames.length) {
      const res = await fetch(url, {
        headers: {
          'STATSIG-API-KEY': consoleApiKey,
          'STATSIG-API-VERSION': '20240601',
        },
      });
      if (!res.ok) {
        const text = await res.text();
        throw new GrowthError(
          'statsig_api_error',
          `Statsig API error ${res.status}`,
          { status: res.status, body: text.slice(0, 500) },
        );
      }
      const body = (await res.json()) as StatsigEventsResponse;
      const rows = Array.isArray(body.data) ? body.data : [];
      const normalizedRows = rows.map(normalizeStatsigEvent).filter((row) => isInWindow(row, window));
      results.push(...normalizedRows);
      if (rows.some((row) => isBeforeWindow(row, window))) break;
      const nextPage = typeof body.pagination?.nextPage === 'string' ? body.pagination.nextPage : null;
      page += 1;
      url = nextPage ? resolveStatsigPageUrl(apiUrl, nextPage) : null;
    }
  }
  return results;
}

async function readStatsigProviderProjectId(root: string, connector: ConnectorConfig): Promise<string | number | undefined> {
  const projectId = connector.statsig?.project_id;
  if (projectId === undefined) return undefined;
  if (isEnvReference(projectId)) return readEnvValue(root, projectId);
  return String(projectId).trim().length > 0 ? projectId : undefined;
}

interface StatsigEventsResponse {
  data?: unknown[];
  pagination?: {
    nextPage?: unknown;
  };
}

function statsigEventsUrl(
  apiUrl: string,
  eventName: string,
  opts: { page: number; limit: number },
): string {
  const url = new URL(`/console/v1/events/${encodeURIComponent(eventName)}`, normalizedStatsigApiUrl(apiUrl));
  url.searchParams.set('page', String(opts.page));
  url.searchParams.set('limit', String(opts.limit));
  return url.toString();
}

function resolveStatsigPageUrl(apiUrl: string, nextPage: string): string {
  return new URL(nextPage, normalizedStatsigApiUrl(apiUrl)).toString();
}

function normalizedStatsigApiUrl(apiUrl: string): string {
  return apiUrl.endsWith('/') ? apiUrl : `${apiUrl}/`;
}

function normalizeStatsigEvent(raw: unknown): unknown {
  if (!isRecord(raw)) return raw;
  if ('eventName' in raw) return normalizeStatsigTimestamp(raw);
  const metadata = isRecord(raw.metadata) ? raw.metadata : {};
  const user = isRecord(raw.user) ? raw.user : {};
  return normalizeStatsigTimestamp({
    ...raw,
    eventName: raw.name,
    user: {
      ...user,
      userID: raw.userID ?? user.userID,
    },
    metadata: {
      ...metadata,
      source: raw.source ?? metadata.source,
      value: raw.value ?? metadata.value,
    },
  });
}

function normalizeStatsigTimestamp(raw: Record<string, unknown>): Record<string, unknown> {
  const timestamp = raw.time ?? raw.timestamp;
  const iso = statsigTimestampToIso(timestamp);
  return iso ? { ...raw, time: iso } : raw;
}

function isInWindow(raw: unknown, window: ConnectorPullWindow): boolean {
  const timestamp = statsigEventTime(raw);
  return !!timestamp && timestamp >= Date.parse(window.after) && timestamp < Date.parse(window.before);
}

function isBeforeWindow(raw: unknown, window: ConnectorPullWindow): boolean {
  const timestamp = statsigEventTime(raw);
  return !!timestamp && timestamp < Date.parse(window.after);
}

function statsigEventTime(raw: unknown): number | null {
  if (!isRecord(raw)) return null;
  const timestamp = raw.time ?? raw.timestamp;
  const parsed = statsigTimestampToMillis(timestamp);
  return Number.isFinite(parsed) ? parsed : null;
}

function statsigTimestampToIso(value: unknown): string | null {
  const timestamp = statsigTimestampToMillis(value);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
}

function statsigTimestampToMillis(value: unknown): number {
  if (typeof value === 'number') return value;
  if (typeof value !== 'string') return NaN;
  if (/^\d+$/.test(value)) return Number(value);
  return Date.parse(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
