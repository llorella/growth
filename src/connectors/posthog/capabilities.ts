import type { ConnectorConfig } from '../types.js';
import { isEnvReference } from '../../lib/connector-catalog.js';
import { readEnvValue } from '../../lib/env-files.js';
import {
  POSTHOG_DEFAULT_API_KEY_ENV,
  POSTHOG_DEFAULT_HOST,
  POSTHOG_DEFAULT_PROJECT_ID,
  POSTHOG_REQUIRED_SCOPES,
  isPostHogPersonalApiKey,
  isPostHogProjectToken,
  postHogApiKeyEnv,
  postHogPersonalApiKeyEnv,
} from './config.js';

export type PostHogCapabilityName = 'telemetry_write' | 'provider_pull';
export type PostHogMissingRequirement = 'api_key' | 'personal_api_key' | 'project_id';

export interface PostHogCapability {
  ready: boolean;
  missing: PostHogMissingRequirement[];
  required_env: string[];
  warnings?: string[];
}

export interface PostHogCapabilityStatus {
  source: string;
  kind: 'posthog';
  host: string;
  api_key_env: string;
  api_key_present: boolean;
  personal_api_key_env: string;
  personal_api_key_present: boolean;
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
  const apiKeyValue = await readEnvValue(root, apiKeyEnv);
  const apiKeyPresent = !!apiKeyValue;

  const personalApiKeyEnv = postHogPersonalApiKeyEnv(connector)!;
  const personalApiKeyValue = await readEnvValue(root, personalApiKeyEnv);
  const personalApiKeyPresent = !!personalApiKeyValue;

  const projectIdRef = postHogProjectIdReference(connector);
  const projectIdEnv = isEnvReference(projectIdRef) ? projectIdRef : undefined;
  const projectIdPresent =
    typeof projectIdRef === 'number' ||
    (typeof projectIdRef === 'string' && (!isEnvReference(projectIdRef) || !!(await readEnvValue(root, projectIdRef))));

  const telemetryMissing: PostHogMissingRequirement[] = [];
  const telemetryWarnings: string[] = [];
  if (!apiKeyPresent) {
    telemetryMissing.push('api_key');
  } else if (isPostHogPersonalApiKey(apiKeyValue)) {
    telemetryWarnings.push(
      `${apiKeyEnv} contains a personal API key (phx_). Telemetry write requires a project token (phc_).`,
    );
  }

  const providerMissing: PostHogMissingRequirement[] = [];
  const providerWarnings: string[] = [];
  if (!personalApiKeyPresent) {
    if (apiKeyPresent && isPostHogPersonalApiKey(apiKeyValue)) {
      providerWarnings.push(
        `${apiKeyEnv} contains a personal API key (phx_) but provider pull expects it in ${personalApiKeyEnv}. ` +
        `Move it with: growth env set --key ${personalApiKeyEnv} --stdin`,
      );
    }
    providerMissing.push('personal_api_key');
  } else if (!isPostHogPersonalApiKey(personalApiKeyValue)) {
    providerWarnings.push(
      `${personalApiKeyEnv} does not look like a personal API key (should start with phx_). Provider pull will likely fail with 401.`,
    );
  }
  if (!projectIdPresent) providerMissing.push('project_id');

  return {
    source: connector.source,
    kind: 'posthog',
    host: connector.posthog?.host ?? POSTHOG_DEFAULT_HOST,
    api_key_env: apiKeyEnv,
    api_key_present: apiKeyPresent,
    personal_api_key_env: personalApiKeyEnv,
    personal_api_key_present: personalApiKeyPresent,
    project_id_required_for_provider_pull: true,
    project_id_configured: connector.posthog?.project_id !== undefined,
    ...(projectIdEnv ? { project_id_env: projectIdEnv } : {}),
    project_id_present: projectIdPresent,
    required_scopes: [...POSTHOG_REQUIRED_SCOPES],
    capabilities: {
      telemetry_write: {
        ready: telemetryMissing.length === 0 && telemetryWarnings.length === 0,
        missing: telemetryMissing,
        required_env: [apiKeyEnv],
        ...(telemetryWarnings.length ? { warnings: telemetryWarnings } : {}),
      },
      provider_pull: {
        ready: providerMissing.length === 0 && providerWarnings.length === 0,
        missing: providerMissing,
        required_env: [personalApiKeyEnv, ...(projectIdEnv ? [projectIdEnv] : [])],
        ...(providerWarnings.length ? { warnings: providerWarnings } : {}),
      },
    },
    missing: [...telemetryMissing, ...providerMissing],
    ...(telemetryMissing.length || providerMissing.length
      ? { setup_command: `growth connector auth setup ${connector.source} --json` }
      : {}),
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
