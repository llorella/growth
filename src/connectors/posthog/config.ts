import { defaultTaxonomyMappings, envProjectIds } from '../../lib/connector-catalog.js';
import type { ConnectorConfig } from '../types.js';

export const POSTHOG_DEFAULT_HOST = 'https://us.posthog.com';
export const POSTHOG_DEFAULT_HOST_ENV = 'POSTHOG_ANALYTICS_HOST';
export const POSTHOG_DEFAULT_PROJECT_ID = 'POSTHOG_PROJECT_ID';
export const POSTHOG_DEFAULT_API_KEY_ENV = 'POSTHOG_ANALYTICS_API_KEY';
export const POSTHOG_DEFAULT_PERSONAL_API_KEY_ENV = 'POSTHOG_PERSONAL_API_KEY';
export const POSTHOG_REQUIRED_SCOPES: string[] = [];

export function postHogApiKeyEnv(
  connector: Pick<ConnectorConfig, 'posthog'>,
): string | undefined {
  return connector.posthog?.api_key_env ?? POSTHOG_DEFAULT_API_KEY_ENV;
}

export function postHogPersonalApiKeyEnv(
  connector: Pick<ConnectorConfig, 'posthog'>,
): string | undefined {
  return connector.posthog?.personal_api_key_env ?? POSTHOG_DEFAULT_PERSONAL_API_KEY_ENV;
}

export function postHogRequiredEnv(
  apiKeyEnv: string | undefined,
  projectId: string | number | undefined,
): string[] {
  return [apiKeyEnv, ...envProjectIds(projectId)].filter((value): value is string => !!value);
}

export function defaultPostHogConnector(
  projectId?: string | number,
  opts: {
    host?: string;
    apiKeyEnv?: string;
    mappings?: ConnectorConfig['mappings'];
  } = {},
): ConnectorConfig {
  return {
    source: 'posthog',
    kind: 'posthog',
    user_id_path: 'distinct_id',
    anonymous_id_path: 'properties.$anon_distinct_id',
    experiment_id_path: 'properties.experiment_id',
    variant_id_path: 'properties.variant_id',
    event_name_path: 'event',
    timestamp_path: 'timestamp',
    idempotency_key_path: 'uuid',
    posthog: {
      host: opts.host ?? POSTHOG_DEFAULT_HOST,
      api_key_env: opts.apiKeyEnv ?? POSTHOG_DEFAULT_API_KEY_ENV,
      ...(projectId !== undefined ? { project_id: projectId } : {}),
    },
    mappings: opts.mappings ?? {},
  };
}

export function isPostHogProjectToken(value: string): boolean {
  return value.startsWith('phc_');
}

export function isPostHogPersonalApiKey(value: string): boolean {
  return value.startsWith('phx_');
}

export function defaultPostHogMappings(): ConnectorConfig['mappings'] {
  return defaultTaxonomyMappings({ includeFrameworkEvent: false });
}
