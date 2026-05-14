import type { ConnectorConfig } from '../types.js';
import { isEnvReference } from '../../lib/connector-catalog.js';
import { readEnvValue } from '../../lib/env-files.js';
import {
  POSTHOG_DEFAULT_API_KEY_ENV,
  POSTHOG_DEFAULT_HOST,
  POSTHOG_DEFAULT_PROJECT_ID,
  POSTHOG_REQUIRED_SCOPES,
  postHogApiKeyEnv,
} from './config.js';

export type PostHogCapabilityName = 'telemetry_write' | 'provider_pull';
export type PostHogMissingRequirement = 'api_key' | 'project_id';

export interface PostHogCapability {
  ready: boolean;
  missing: PostHogMissingRequirement[];
  required_env: string[];
}

export interface PostHogCapabilityStatus {
  source: string;
  kind: 'posthog';
  host: string;
  api_key_env: string;
  api_key_present: boolean;
  project_id_required_for_provider_pull: true;
  project_id_configured: boolean;
  project_id_env?: string;
  project_id_present: boolean;
  required_scopes: string[];
  capabilities: {
    telemetry_write: PostHogCapability;
    provider_pull: PostHogCapability;
  };
  missing: PostHogMissingRequirement[];
  setup_command?: string;
}

export async function postHogCapabilityStatus(
  root: string,
  connector: ConnectorConfig,
): Promise<PostHogCapabilityStatus> {
  const apiKeyEnv = postHogApiKeyEnv(connector) ?? POSTHOG_DEFAULT_API_KEY_ENV;
  const apiKeyPresent = !!(await readEnvValue(root, apiKeyEnv));
  const projectIdRef = postHogProjectIdReference(connector);
  const projectIdEnv = isEnvReference(projectIdRef) ? projectIdRef : undefined;
  const projectIdPresent =
    typeof projectIdRef === 'number' ||
    (typeof projectIdRef === 'string' && (!isEnvReference(projectIdRef) || !!(await readEnvValue(root, projectIdRef))));

  const telemetryMissing: PostHogMissingRequirement[] = [];
  if (!apiKeyPresent) telemetryMissing.push('api_key');

  const providerMissing: PostHogMissingRequirement[] = [...telemetryMissing];
  if (!projectIdPresent) providerMissing.push('project_id');

  return {
    source: connector.source,
    kind: 'posthog',
    host: connector.posthog?.host ?? POSTHOG_DEFAULT_HOST,
    api_key_env: apiKeyEnv,
    api_key_present: apiKeyPresent,
    project_id_required_for_provider_pull: true,
    project_id_configured: connector.posthog?.project_id !== undefined,
    ...(projectIdEnv ? { project_id_env: projectIdEnv } : {}),
    project_id_present: projectIdPresent,
    required_scopes: [...POSTHOG_REQUIRED_SCOPES],
    capabilities: {
      telemetry_write: {
        ready: telemetryMissing.length === 0,
        missing: telemetryMissing,
        required_env: [apiKeyEnv],
      },
      provider_pull: {
        ready: providerMissing.length === 0,
        missing: providerMissing,
        required_env: [apiKeyEnv, ...(projectIdEnv ? [projectIdEnv] : [])],
      },
    },
    missing: providerMissing,
    ...(providerMissing.length ? { setup_command: `growth connector auth setup ${connector.source} --json` } : {}),
  };
}

export async function readPostHogProviderProjectId(
  root: string,
  connector: ConnectorConfig,
): Promise<string | number | undefined> {
  const projectIdRef = postHogProjectIdReference(connector);
  return typeof projectIdRef === 'string' && isEnvReference(projectIdRef)
    ? await readEnvValue(root, projectIdRef)
    : projectIdRef;
}

export function postHogProjectIdReference(connector: ConnectorConfig): string | number {
  return connector.posthog?.project_id ?? POSTHOG_DEFAULT_PROJECT_ID;
}
