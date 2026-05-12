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
  isEnvReference,
} from '../lib/connector-catalog.js';
import { paths } from '../lib/paths.js';
import { readShared, writeShared } from '../lib/state.js';
import { GrowthError } from '../lib/envelope.js';
import { parseEnvText, readEnvValue } from '../lib/env-files.js';

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

  const auth = connector.command('auth').description('Connector authentication helpers.');
  auth
    .command('check <source>')
    .description('Check connector auth readiness without printing secrets.')
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
        const apiKeyEnv = connectorApiKeyEnv(c);
        const projectId = c.posthog?.project_id;
        const projectIdPresent =
          projectId === undefined
            ? true
            : isEnvReference(projectId)
            ? !!(await readEnvValue(ctx.getRoot(), projectId))
            : projectId !== undefined;
        const apiKeyPresent = apiKeyEnv ? !!(await readEnvValue(ctx.getRoot(), apiKeyEnv)) : true;
        return {
          data: {
            source: c.source,
            kind: c.kind,
            host: c.posthog?.host,
            project_id_required: projectId !== undefined,
            project_id_present: projectIdPresent,
            api_key_env: apiKeyEnv,
            api_key_present: apiKeyPresent,
            required_scopes: connectorRequiredScopes(c.kind),
          },
          humanText: `${source} auth: project_id=${projectId === undefined ? 'not required' : projectIdPresent ? 'present' : 'missing'} api_key=${apiKeyPresent ? 'present' : 'missing'}`,
          nextSteps:
            apiKeyPresent && projectIdPresent
              ? [`growth connector validate ${source} --json`]
              : [`Set ${apiKeyEnv ?? 'the connector API key env var'}${projectId === undefined ? '' : ' and project id'}, then rerun this command.`],
        };
      });
    });
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
