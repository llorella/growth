import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { Experiment } from '../../core/experiment/types.js';
import {
  requiredConnectorEvents,
} from '../../lib/connector-catalog.js';
import type { ConnectorConfig } from '../../lib/connectors.js';
import { readEnvValue } from '../../lib/env-files.js';
import { parseEnvText } from '../../lib/env-files.js';
import { GrowthError } from '../../lib/envelope.js';
import {
  postHogCapabilityStatus,
  postHogProjectIdReference,
  readPostHogProviderProjectId,
  type PostHogCapabilityStatus,
  type PostHogMissingRequirement,
} from './capabilities.js';
import {
  POSTHOG_DEFAULT_API_KEY_ENV,
  POSTHOG_DEFAULT_HOST,
  POSTHOG_DEFAULT_HOST_ENV,
  POSTHOG_DEFAULT_PROJECT_ID,
  POSTHOG_REQUIRED_SCOPES,
  defaultPostHogConnector,
  defaultPostHogMappings,
  postHogApiKeyEnv,
  postHogRequiredEnv,
} from './config.js';
import { providerCapabilityPolicy } from '../auth-policy.js';
import { mapConnectorEvent } from '../mapping.js';
import type {
  ConnectorAdapter,
  ConnectorCapabilityStatus,
  ConnectorDefaultConfigInput,
  ConnectorPullWindow,
} from '../types.js';

export const postHogAdapter: ConnectorAdapter = {
  kind: 'posthog',
  defaultSource: 'posthog',
  sourceAliases: ['posthog'],
  importProviders: ['stripe-projects'],
  evidenceSource: 'posthog',
  providerBacked: true,

  defaultConfig(input: ConnectorDefaultConfigInput): ConnectorConfig {
    return defaultPostHogConnector(input.projectId, {
      host: input.host ?? POSTHOG_DEFAULT_HOST,
      apiKeyEnv: input.apiKeyEnv ?? POSTHOG_DEFAULT_API_KEY_ENV,
      ...(input.mappings ? { mappings: input.mappings } : {}),
    });
  },

  async importConnector(root: string, context) {
    if (context.provider !== 'stripe-projects') {
      throw new GrowthError('unsupported_import_provider', `Provider "${context.provider}" is not supported by PostHog.`, {
        supported: this.importProviders,
      });
    }
    const imported = await discoverStripeProjectsPostHog(root);
    return {
      source: this.defaultSource,
      connector: this.defaultConfig({
        source: this.defaultSource,
        projectId: imported.projectId,
        host: imported.host,
        apiKeyEnv: imported.apiKeyEnv,
        mappings: shouldPreserveMappings(context.existing?.mappings)
          ? context.existing!.mappings
          : defaultPostHogMappings(),
      }),
      imported_from: imported.source_file,
    };
  },

  requiredEnv(connector: ConnectorConfig): string[] {
    return postHogRequiredEnv(postHogApiKeyEnv(connector), connector.posthog?.project_id);
  },

  requiredScopes(): string[] {
    return [...POSTHOG_REQUIRED_SCOPES];
  },

  authEnv(connector: ConnectorConfig): string | undefined {
    return postHogApiKeyEnv(connector);
  },

  mappedEvents(connector: ConnectorConfig): string[] {
    return Object.entries(connector.mappings).map(([sourceEvent, rule]) => rule.framework_event ?? sourceEvent);
  },

  validateConfig(connector: ConnectorConfig) {
    const issues = [];
    if (!isRecord(connector.posthog)) {
      issues.push({ source: connector.source, message: 'missing posthog config block', path: 'posthog' });
    } else {
      if (connector.posthog.host !== undefined && typeof connector.posthog.host !== 'string') {
        issues.push({ source: connector.source, message: 'posthog.host must be a string', path: 'posthog.host' });
      }
      if (
        connector.posthog.project_id !== undefined &&
        typeof connector.posthog.project_id !== 'string' &&
        typeof connector.posthog.project_id !== 'number'
      ) {
        issues.push({ source: connector.source, message: 'posthog.project_id must be a string or number', path: 'posthog.project_id' });
      }
      if (connector.posthog.api_key_env !== undefined && typeof connector.posthog.api_key_env !== 'string') {
        issues.push({ source: connector.source, message: 'posthog.api_key_env must be a string', path: 'posthog.api_key_env' });
      }
    }
    return issues;
  },

  async capabilityStatus(root: string, connector: ConnectorConfig): Promise<ConnectorCapabilityStatus> {
    const status = await postHogCapabilityStatus(root, connector);
    return {
      source: status.source,
      kind: status.kind,
      provider_backed: true,
      capabilities: status.capabilities,
      setup_command: status.setup_command,
    };
  },

  coverage(connector: ConnectorConfig, experiment: Experiment): boolean {
    const mapped = new Set(this.mappedEvents(connector));
    return requiredConnectorEvents(experiment).every((event) => mapped.has(event));
  },

  async authCheck(root: string, connector: ConnectorConfig) {
    const authStatus = await postHogCapabilityStatus(root, connector);
    const ready = authStatus.capabilities.provider_pull.ready;
    return {
      data: authStatus,
      humanText: `${connector.source} capabilities: telemetry_write=${authStatus.capabilities.telemetry_write.ready ? 'ready' : 'blocked'} provider_pull=${ready ? 'ready' : 'blocked'}`,
      nextSteps:
        ready
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
    const authStatus = await postHogCapabilityStatus(root, connector);
    const setup = await postHogAuthSetup(root, connector, authStatus);
    const ready = authStatus.capabilities.provider_pull.ready;
    return {
      data: setup,
      humanText: ready
        ? `${connector.source} auth setup: ready`
        : `${connector.source} provider pull setup: missing ${authStatus.capabilities.provider_pull.missing.join(', ')}`,
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
    return fetchPostHog(root, connector, window, limit);
  },

  providerPullBlockReason(connector: ConnectorConfig, status: ConnectorCapabilityStatus): string {
    const telemetryWrite = status.capabilities.telemetry_write;
    const providerPull = status.capabilities.provider_pull;
    if (telemetryWrite?.ready && providerPull?.missing.length === 1 && providerPull.missing[0] === 'project_id') {
      return `${connector.source} app telemetry is configured, but provider-backed preflight needs a PostHog project id to pull synthetic events.`;
    }
    return `${connector.source} provider-backed preflight is blocked because required read-side values are missing: ${providerPull?.missing.join(', ') ?? 'unknown'}.`;
  },

  providerPullBlockedWhy(status: ConnectorCapabilityStatus): string {
    return status.capabilities.telemetry_write?.ready
      ? 'PostHog app telemetry is configured, but provider-backed evidence pull is not ready.'
      : 'A PostHog connector is configured, but telemetry and provider-backed evidence are not ready.';
  },

  coverageBlockedWhy(): string {
    return 'A provider-backed PostHog connector is configured and auth is ready, but mappings do not cover the experiment events.';
  },

  readyWhy(): string {
    return 'Provider-backed PostHog evidence is configured and should validate synthetic preflight ingestion.';
  },
};

interface PostHogAuthRequirement {
  id: string;
  capability: 'telemetry_write' | 'provider_pull';
  field: PostHogMissingRequirement;
  env?: string;
  present: boolean;
  manual_input_required: boolean;
  safe_commands: string[];
  guidance: string;
}

async function postHogAuthSetup(
  root: string,
  connector: ConnectorConfig,
  authStatus: PostHogCapabilityStatus,
): Promise<{
  source: string;
  kind: 'posthog';
  ready: boolean;
  resolution: 'ready' | 'manual_input_required';
  blocked: boolean;
  manual_input_required: boolean;
  safe_commands: string[];
  retry_command: string;
  stop_reason?: string;
  telemetry_write_ready: boolean;
  provider_pull_ready: boolean;
  status: PostHogCapabilityStatus;
  missing_requirements: PostHogAuthRequirement[];
  import_suggestion?: { provider: 'stripe-projects'; command: string; reason: string };
  policy: ReturnType<typeof providerCapabilityPolicy>;
}> {
  const importSuggestion = await stripeProjectsImportSuggestion(root, connector, authStatus);
  const requirements: PostHogAuthRequirement[] = [];
  if (!authStatus.api_key_present) {
    requirements.push({
      id: 'posthog-api-key',
      capability: 'telemetry_write',
      field: 'api_key',
      env: authStatus.api_key_env,
      present: false,
      manual_input_required: true,
      safe_commands: authStatus.api_key_env ? [`growth env set --key ${authStatus.api_key_env} --stdin`] : [],
      guidance: authStatus.api_key_env
        ? `Provide the PostHog analytics API key through growth env set for ${authStatus.api_key_env}.`
        : 'Configure posthog.api_key_env on the connector, then rerun auth setup.',
    });
  }
  if (!authStatus.project_id_present) {
    requirements.push({
      id: 'posthog-provider-pull-project-id',
      capability: 'provider_pull',
      field: 'project_id',
      env: authStatus.project_id_env,
      present: false,
      manual_input_required: true,
      safe_commands: authStatus.project_id_env ? [`growth env set --key ${authStatus.project_id_env} --stdin`] : [],
      guidance: authStatus.project_id_env
        ? `Provide the numeric PostHog project id from PostHog project settings through growth env set for ${authStatus.project_id_env}.`
        : 'Set posthog.project_id to an env var name or numeric project id with growth connector add/import, then rerun auth setup.',
    });
  }
  const ready = authStatus.capabilities.provider_pull.ready;
  return {
    source: connector.source,
    kind: 'posthog',
    ready,
    resolution: ready ? 'ready' : 'manual_input_required',
    blocked: !ready,
    manual_input_required: !ready && requirements.some((requirement) => requirement.manual_input_required),
    safe_commands: requirements.flatMap((requirement) => requirement.safe_commands),
    retry_command: `growth connector auth check ${connector.source} --json`,
    ...(!ready
      ? {
          stop_reason:
            'Provider-backed evidence setup requires manual read-side values. Stop automated provider preflight until the missing values are supplied through Growth commands.',
        }
      : {}),
    telemetry_write_ready: authStatus.capabilities.telemetry_write.ready,
    provider_pull_ready: authStatus.capabilities.provider_pull.ready,
    status: authStatus,
    missing_requirements: requirements,
    ...(importSuggestion ? { import_suggestion: importSuggestion } : {}),
    policy: providerCapabilityPolicy(),
  };
}

async function stripeProjectsImportSuggestion(
  root: string,
  connector: ConnectorConfig,
  authStatus: PostHogCapabilityStatus,
): Promise<{ provider: 'stripe-projects'; command: string; reason: string } | undefined> {
  if (authStatus.capabilities.provider_pull.ready) return undefined;
  try {
    const imported = await discoverStripeProjectsPostHog(root);
    if (
      imported.apiKeyEnv !== postHogApiKeyEnv(connector) ||
      imported.host !== connector.posthog?.host ||
      (imported.projectId !== undefined && imported.projectId !== connector.posthog?.project_id)
    ) {
      return {
        provider: 'stripe-projects',
        command: 'growth connector import stripe-projects --json --yes',
        reason: `Stripe Projects metadata references PostHog connector settings in ${imported.source_file}.`,
      };
    }
  } catch {
    // Setup remains useful without Stripe Projects metadata.
  }
  return undefined;
}

export async function discoverStripeProjectsPostHog(root: string): Promise<{
  host: string;
  projectId?: string | number;
  apiKeyEnv: string;
  source_file: string;
}> {
  const candidates = [
    path.join(root, '.projects', 'state.json'),
    path.join(root, '.projects', 'state.local.json'),
    path.join(root, '.projects', 'providers.json'),
    path.join(root, '.stripe-projects', 'state.json'),
    path.join(root, '.env'),
    path.join(root, '.env.local'),
    path.join(root, '.env.development'),
    path.join(root, '.env.development.local'),
  ];
  const found: Array<{ file: string; text: string }> = [];
  for (const file of candidates) {
    try {
      found.push({ file, text: await fs.readFile(file, 'utf8') });
    } catch {
      // candidate absent
    }
  }
  if (found.length === 0) {
    throw new GrowthError('stripe_projects_context_not_found', 'No Stripe Projects metadata was found.', {
      checked: candidates.map((file) => path.relative(root, file)),
      hint: 'Run Stripe Projects setup first, or add the PostHog connector with explicit --project-id and --api-key-env.',
    });
  }

  const matches = found
    .map((candidate) => ({ ...candidate, parsed: safeJson(candidate.text) }))
    .map((candidate) => {
      const envCandidate = findPostHogEnvCandidate(candidate.text, path.relative(root, candidate.file));
      if (envCandidate) {
        return envCandidate;
      }
      const text = candidate.text;
      const projectId =
        findString(candidate.parsed, [POSTHOG_DEFAULT_PROJECT_ID, 'POSTHOG_PROJECT', 'project_id_env']) ??
        (text.includes(POSTHOG_DEFAULT_PROJECT_ID) ? POSTHOG_DEFAULT_PROJECT_ID : undefined);
      const apiKeyEnv =
        findString(candidate.parsed, [POSTHOG_DEFAULT_API_KEY_ENV, 'POSTHOG_API_KEY', 'api_key_env']) ??
        (text.includes(POSTHOG_DEFAULT_API_KEY_ENV) ? POSTHOG_DEFAULT_API_KEY_ENV : undefined);
      const host =
        findUrl(candidate.parsed, 'posthog') ??
        (text.includes('eu.posthog.com') ? 'https://eu.posthog.com' : POSTHOG_DEFAULT_HOST);
      return apiKeyEnv
        ? {
            host,
            projectId,
            apiKeyEnv,
            source_file: path.relative(root, candidate.file),
          }
        : null;
    })
    .filter((candidate): candidate is { host: string; projectId?: string | number; apiKeyEnv: string; source_file: string } => !!candidate);

  if (matches.length === 0) {
    throw new GrowthError('posthog_context_not_found', 'No PostHog analytics env names were found.', {
      checked: found.map((candidate) => path.relative(root, candidate.file)),
      hint: `Set ${POSTHOG_DEFAULT_API_KEY_ENV} and ${POSTHOG_DEFAULT_HOST_ENV}, or add the PostHog connector explicitly.`,
    });
  }
  const unique = new Map(matches.map((m) => [`${m.host}|${m.projectId}|${m.apiKeyEnv}`, m]));
  if (unique.size > 1) {
    throw new GrowthError('multiple_posthog_contexts', 'Multiple PostHog contexts were found in Stripe Projects metadata.', {
      candidates: Array.from(unique.values()),
      hint: 'Add the PostHog connector explicitly with --project-id, --api-key-env, and --host.',
    });
  }
  return Array.from(unique.values())[0];
}

function findPostHogEnvCandidate(
  text: string,
  source_file: string,
): { host: string; projectId?: string | number; apiKeyEnv: string; source_file: string } | null {
  const env = parseEnvText(text);
  const analyticsKeyCandidates = ['POSTHOG_ANALYTICS_API_KEY', 'POST_HOG_ANALYTICS_API_KEY'];
  const analyticsHostCandidates = ['POSTHOG_ANALYTICS_HOST', 'POST_HOG_ANALYTICS_HOST', 'POSTHOG_HOST'];
  const analyticsApiKeyEnv = analyticsKeyCandidates.find((key) => key in env);
  if (analyticsApiKeyEnv) {
    const hostKey = analyticsHostCandidates.find((key) => key in env);
    return {
      host: hostKey ? env[hostKey] : POSTHOG_DEFAULT_HOST,
      apiKeyEnv: analyticsApiKeyEnv,
      source_file,
    };
  }

  const bases = ['POSTHOG_ANALYTICS', 'POSTHOG', 'POSTHOG_PLAN'];
  for (const base of bases) {
    const apiKeyEnv = `${base}_PERSONAL_API_KEY`;
    if (!(apiKeyEnv in env)) continue;
    const projectIdEnv = `${base}_PROJECT_ID`;
    const projectId = projectIdEnv in env ? projectIdEnv : POSTHOG_DEFAULT_PROJECT_ID in env ? POSTHOG_DEFAULT_PROJECT_ID : undefined;
    return {
      host: env[`${base}_HOST`] ?? env.POSTHOG_HOST ?? POSTHOG_DEFAULT_HOST,
      projectId,
      apiKeyEnv,
      source_file,
    };
  }
  return null;
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function findString(value: unknown, keys: string[]): string | undefined {
  if (!value || typeof value !== 'object') return undefined;
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (keys.includes(key) && typeof child === 'string') return child;
    if (typeof child === 'string' && keys.includes(child)) return child;
    const found = findString(child, keys);
    if (found) return found;
  }
  return undefined;
}

function findUrl(value: unknown, needle: string): string | undefined {
  if (!value || typeof value !== 'object') return undefined;
  for (const child of Object.values(value as Record<string, unknown>)) {
    if (typeof child === 'string' && child.includes(needle) && /^https?:\/\//.test(child)) return child;
    const found = findUrl(child, needle);
    if (found) return found;
  }
  return undefined;
}

function shouldPreserveMappings(mappings: ConnectorConfig['mappings'] | undefined): boolean {
  if (!mappings || Object.keys(mappings).length === 0) return false;
  return Object.values(mappings).some(
    (mapping) => mapping.framework_event || mapping.payload_paths || mapping.payload_static,
  );
}

async function fetchPostHog(
  root: string,
  connector: ConnectorConfig,
  window: ConnectorPullWindow,
  limit: number,
): Promise<unknown[]> {
  if (!connector.posthog) {
    throw new GrowthError(
      'connector_misconfigured',
      'posthog connector is missing the `posthog` config block (host, project_id, api_key_env).',
    );
  }
  const apiKeyEnv = postHogApiKeyEnv(connector) ?? POSTHOG_DEFAULT_API_KEY_ENV;
  const apiKey = await readEnvValue(root, apiKeyEnv);
  if (!apiKey) {
    throw new GrowthError(
      'missing_api_key',
      `Set ${apiKeyEnv} to the PostHog API key configured for this app.`,
    );
  }
  const host = connector.posthog.host ?? POSTHOG_DEFAULT_HOST;
  const configuredProjectId = postHogProjectIdReference(connector);
  const projectId = await readPostHogProviderProjectId(root, connector);
  if (!projectId) {
    throw new GrowthError(
      'missing_project_id',
      `PostHog provider pulls require a project id. App telemetry can be configured with the analytics API key and host, but provider-backed preflight needs ${configuredProjectId} to read events back from PostHog.`,
    );
  }

  const eventNames = Object.keys(connector.mappings);
  const results: unknown[] = [];
  for (const eventName of eventNames) {
    const params = new URLSearchParams({ event: eventName, limit: String(limit) });
    params.set('after', window.after);
    params.set('before', window.before);

    let url: string | null = `${host}/api/projects/${projectId}/events/?${params.toString()}`;
    while (url) {
      const res = await fetch(url, { headers: { Authorization: `Bearer ${apiKey}` } });
      if (!res.ok) {
        const text = await res.text();
        throw new GrowthError(
          'posthog_api_error',
          `PostHog API error ${res.status}`,
          { status: res.status, body: text.slice(0, 500) },
        );
      }
      const body = (await res.json()) as { results: unknown[]; next: string | null };
      results.push(...body.results);
      url = body.next && results.length < limit * eventNames.length ? body.next : null;
    }
  }
  return results;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
