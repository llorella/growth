import type { Command } from 'commander';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { wrap, type RunCtx } from '../lib/runner.js';
import { requireInitialized } from '../lib/gating.js';
import { Store } from '../lib/store.js';
import {
  assertCoverage,
  getConnector,
  listConnectors,
  validateConnectorConfig,
  type ConnectorConfig,
} from '../lib/connectors.js';
import {
  POSTHOG_DEFAULT_API_KEY_ENV,
  POSTHOG_DEFAULT_HOST,
  POSTHOG_DEFAULT_HOST_ENV,
  POSTHOG_DEFAULT_PROJECT_ID,
  connectorApiKeyEnv,
  connectorRequiredEnv,
  connectorRequiredScopes,
  defaultLocalConnector,
  defaultPostHogConnector,
  defaultPostHogMappings,
} from '../lib/connector-catalog.js';
import {
  postHogCapabilityStatus,
  type PostHogCapabilityStatus,
  type PostHogMissingRequirement,
} from '../lib/posthog-capabilities.js';
import { paths } from '../lib/paths.js';
import { readShared, writeShared } from '../lib/state.js';
import { GrowthError } from '../lib/envelope.js';
import { parseEnvText } from '../lib/env-files.js';

export function registerConnectors(program: Command, ctx: RunCtx): void {
  const connector = program
    .command('connector')
    .alias('connectors')
    .description('Manage data-source connectors.');

  connector
    .command('list')
    .description('List installed connectors.')
    .action(async () => {
      await wrap('growth connector list', ctx, async () => {
        await requireInitialized(ctx.getRoot());
        const all = await listConnectors(ctx.getRoot());
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
      });
    });

  connector
    .command('add <source>')
    .description('Create a connector config.')
    .option('--project-id <id>', 'Optional PostHog project id or env var name for read/pull APIs.')
    .option('--host <url>', 'PostHog host.', POSTHOG_DEFAULT_HOST)
    .option('--api-key-env <name>', 'Environment variable containing the API key.', POSTHOG_DEFAULT_API_KEY_ENV)
    .option('--events-file <path>', 'Local JSONL event stream for `local` connectors.', 'tmp/events.jsonl')
    .option('--from-stripe-projects', 'Import PostHog connector metadata from Stripe Projects context.', false)
    .action(async (source: string, opts: { projectId?: string; host: string; apiKeyEnv: string; eventsFile: string; fromStripeProjects?: boolean }) => {
      await wrap('growth connector add', ctx, async () => {
        await requireInitialized(ctx.getRoot());
        if (opts.fromStripeProjects) {
          if (source !== 'posthog') {
            throw new GrowthError('unsupported_import', '--from-stripe-projects currently supports posthog connectors.');
          }
          return importStripeProjectsPostHog(ctx, source);
        }
        if (!['posthog', 'local', 'native-app'].includes(source)) {
          throw new GrowthError('unsupported_connector', 'Connector scaffolding supports posthog and local.', {
            supported: ['local', 'posthog'],
          });
        }
        const p = paths(ctx.getRoot());
        await fs.mkdir(p.connectorsDir, { recursive: true });
        const normalizedSource = source === 'native-app' ? 'local' : source;
        const file = path.join(p.connectorsDir, `${normalizedSource}.json`);
        const existing = await getConnector(ctx.getRoot(), normalizedSource);
        if (existing) {
          throw new GrowthError('already_exists', `Connector "${normalizedSource}" already exists.`);
        }
        const config =
          normalizedSource === 'local'
            ? defaultLocalConnector(opts.eventsFile)
            : defaultPostHogConnector(opts.projectId, {
                host: opts.host,
                apiKeyEnv: opts.apiKeyEnv,
              });
        await fs.writeFile(file, JSON.stringify(config, null, 2) + '\n');
        const shared = await readShared(ctx.getRoot());
        if (shared) {
          shared.connectors[normalizedSource] = {
            status: 'configured',
            config_file: path.relative(ctx.getRoot(), file),
            required_env: connectorRequiredEnv(config),
            required_scopes: connectorRequiredScopes(config.kind),
          };
          await writeShared(ctx.getRoot(), shared);
        }
        return {
          data: { connector: config, file },
          humanText: `Created ${normalizedSource} connector at ${file}.`,
          nextSteps:
            normalizedSource === 'posthog'
              ? [
                  `Map experiment events in ${path.relative(ctx.getRoot(), file)}.`,
                  `growth connector auth check ${normalizedSource} --json`,
                  `growth connector validate ${normalizedSource} --json`,
                ]
              : [
                  `Write app-emitted JSONL events to ${opts.eventsFile}.`,
                  `growth connector validate ${normalizedSource} --json`,
                  `growth pull <experiment_id> --source ${normalizedSource} --json`,
                ],
        };
      });
    });

  connector
    .command('import <provider>')
    .description('Import connector metadata from another deterministic provider context.')
    .action(async (provider: string) => {
      await wrap('growth connector import', ctx, async () => {
        await requireInitialized(ctx.getRoot());
        if (provider !== 'stripe-projects') {
          throw new GrowthError('unsupported_import_provider', `Provider "${provider}" is not supported.`, {
            supported: ['stripe-projects'],
          });
        }
        return importStripeProjectsPostHog(ctx, 'posthog');
      });
    });

  connector
    .command('show <source>')
    .description('Show one connector config.')
    .action(async (source: string) => {
      await wrap('growth connector show', ctx, async () => {
        await requireInitialized(ctx.getRoot());
        const c = await getConnector(ctx.getRoot(), source);
        if (!c) throw new GrowthError('not_found', `Connector "${source}" not found.`);
        return { data: { connector: c }, humanText: JSON.stringify(c, null, 2) };
      });
    });

  connector
    .command('validate [source]')
    .alias('check')
    .description('Validate connector shape and field coverage against active experiments.')
    .action(async (source?: string) => {
      await wrap('growth connector validate', ctx, async () => {
        await requireInitialized(ctx.getRoot());
        const store = new Store(ctx.getRoot());
        const [experiments, connectors] = await Promise.all([
          store.listExperiments(),
          listConnectors(ctx.getRoot()),
        ]);
        if (source && !connectors.some((c) => c.source === source)) {
          throw new GrowthError('not_found', `Connector "${source}" not found.`);
        }
        const selectedConnectors = source ? connectors.filter((c) => c.source === source) : connectors;
        validateConnectorShapes(selectedConnectors);
        assertCoverage(experiments, selectedConnectors);
        return {
          data: {
            ok: true,
            experiments: experiments.length,
            connectors: selectedConnectors.length,
          },
          humanText: `Coverage OK across ${experiments.length} experiment(s) and ${selectedConnectors.length} connector(s).`,
        };
      });
    });

  const auth = connector.command('auth').description('Connector provider capability helpers.');
  auth
    .command('check <source>')
    .description('Check connector telemetry and provider-pull readiness without printing secrets.')
    .action(async (source: string) => {
      await wrap<unknown>('growth connector auth check', ctx, async () => {
        await requireInitialized(ctx.getRoot());
        const c = await getConnector(ctx.getRoot(), source);
        if (!c) throw new GrowthError('not_found', `Connector "${source}" not found.`);
        if (c.kind !== 'posthog') {
          return {
            data: {
              source: c.source,
              kind: c.kind,
              auth_required: false,
              required_scopes: [],
            },
            humanText: `${source} auth: not required`,
            nextSteps: [`growth connector validate ${source} --json`],
          };
        }
        const authStatus = await postHogCapabilityStatus(ctx.getRoot(), c);
        const ready = authStatus.capabilities.provider_pull.ready;
        return {
          data: authStatus,
          humanText: `${source} capabilities: telemetry_write=${authStatus.capabilities.telemetry_write.ready ? 'ready' : 'blocked'} provider_pull=${ready ? 'ready' : 'blocked'}`,
          nextSteps:
            ready
              ? [`growth connector validate ${source} --json`]
              : [`growth connector auth setup ${source} --json`],
          next: ready
            ? {
                command: `growth connector validate ${source} --json`,
                until: 'connector mappings validate against active experiments',
              }
            : {
                command: `growth connector auth setup ${source} --json`,
                until: 'missing provider-pull requirements are resolved through Growth',
              },
        };
      });
    });

  auth
    .command('setup <source>')
    .description('Explain safe setup steps for provider capabilities without printing secrets.')
    .action(async (source: string) => {
      await wrap<unknown>('growth connector auth setup', ctx, async () => {
        await requireInitialized(ctx.getRoot());
        const c = await getConnector(ctx.getRoot(), source);
        if (!c) throw new GrowthError('not_found', `Connector "${source}" not found.`);
        if (c.kind !== 'posthog') {
          return {
            data: {
              source: c.source,
              kind: c.kind,
              ready: true,
              resolution: 'ready',
              blocked: false,
              manual_input_required: false,
              safe_commands: [],
              retry_command: `growth connector auth check ${source} --json`,
              auth_required: false,
              missing_requirements: [],
              policy: providerCapabilityPolicy(),
            },
            humanText: `${source} auth setup: not required`,
            nextSteps: [`growth connector validate ${source} --json`],
            next: {
              command: `growth connector validate ${source} --json`,
              until: 'connector mappings validate against active experiments',
            },
          };
        }

        const authStatus = await postHogCapabilityStatus(ctx.getRoot(), c);
        const setup = await postHogAuthSetup(ctx.getRoot(), c, authStatus);
        const ready = authStatus.capabilities.provider_pull.ready;
        return {
          data: setup,
          humanText: ready
            ? `${source} auth setup: ready`
            : `${source} provider pull setup: missing ${authStatus.capabilities.provider_pull.missing.join(', ')}`,
          nextSteps: ready
            ? [`growth connector validate ${source} --json`]
            : [
                'Stop automated provider-backed preflight until the missing read-side values are supplied.',
                'Manual input required: supply missing provider-pull values through Growth env commands.',
                'Do not read .env files or call analytics provider APIs directly.',
              ],
          next: ready
            ? {
                command: `growth connector validate ${source} --json`,
                until: 'connector mappings validate against active experiments',
              }
            : undefined,
        };
      });
    });
}

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
      imported.apiKeyEnv !== connectorApiKeyEnv(connector) ||
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

function providerCapabilityPolicy() {
  return {
    secret_safe: true,
    do_not_read_env_files_directly: true,
    do_not_probe_provider_apis_directly: true,
    use_growth_commands: [
      'growth connector auth check <source> --json',
      'growth connector auth setup <source> --json',
      'growth env set --key <KEY> --stdin',
    ],
  };
}

function validateConnectorShapes(connectors: ConnectorConfig[]): void {
  const errors = connectors.flatMap(validateConnectorConfig);
  if (errors.length) {
    throw new GrowthError('invalid_connector', 'Connector validation failed.', { errors });
  }
}

async function importStripeProjectsPostHog(ctx: RunCtx, source: string) {
  const root = ctx.getRoot();
  const p = paths(root);
  await fs.mkdir(p.connectorsDir, { recursive: true });
  const file = path.join(p.connectorsDir, `${source}.json`);
  const existing = await getConnector(root, source);
  if (existing && !ctx.assumeYes()) {
    throw new GrowthError('already_exists', `Connector "${source}" already exists. Pass --yes to overwrite it.`);
  }

  const imported = await discoverStripeProjectsPostHog(root);
  const config = defaultPostHogConnector(imported.projectId, {
    host: imported.host,
    apiKeyEnv: imported.apiKeyEnv,
    mappings: shouldPreserveMappings(existing?.mappings) ? existing!.mappings : defaultPostHogMappings(),
  });
  await fs.writeFile(file, JSON.stringify(config, null, 2) + '\n');
  const shared = await readShared(root);
  const requiredEnv = connectorRequiredEnv(config);
  if (shared) {
    shared.connectors[source] = {
      status: 'configured',
      config_file: path.relative(root, file),
      required_env: requiredEnv,
      required_scopes: connectorRequiredScopes(config.kind),
    };
    await writeShared(root, shared);
  }
  return {
    data: { connector: config, file, imported_from: imported.source_file },
    humanText: `Imported ${source} connector from Stripe Projects metadata at ${imported.source_file}.`,
    nextSteps: [`growth connector auth check ${source} --json`, `growth connector validate ${source} --json`],
    next: {
      command: `growth connector auth check ${source} --json`,
      until: 'PostHog connector auth is ready without exposing secrets',
    },
  };
}

async function discoverStripeProjectsPostHog(root: string): Promise<{
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

function shouldPreserveMappings(mappings: ConnectorConfig['mappings'] | undefined): boolean {
  if (!mappings || Object.keys(mappings).length === 0) return false;
  return Object.values(mappings).some(
    (mapping) => mapping.framework_event || mapping.payload_paths || mapping.payload_static,
  );
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
