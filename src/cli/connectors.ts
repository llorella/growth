import type { Command } from 'commander';
import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { wrap, type RunCtx } from '../lib/runner.js';
import { requireInitialized } from '../lib/gating.js';
import { Store } from '../lib/store.js';
import {
  assertCoverage,
  defaultLocalConnector,
  defaultPostHogConnector,
  getConnector,
  listConnectors,
  type ConnectorConfig,
} from '../lib/connectors.js';
import { paths } from '../lib/paths.js';
import { readShared, writeShared } from '../lib/state.js';
import { GrowthError } from '../lib/envelope.js';
import { parseEnvText, readEnvValue, readLocalEnv } from '../lib/env-files.js';
import { DEFAULT_EVENT_TAXONOMY } from '../lib/defaults.js';

const execFileAsync = promisify(execFile);

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
    .option('--project-id <id>', 'PostHog project id or env var name.', 'POSTHOG_PROJECT_ID')
    .option('--host <url>', 'PostHog host.', 'https://us.posthog.com')
    .option('--api-key-env <name>', 'Environment variable containing the API key.', 'POSTHOG_PERSONAL_API_KEY')
    .option('--events-file <path>', 'Local JSONL event stream for `local` connectors.', 'tmp/events.jsonl')
    .option('--from-stripe-projects', 'Import PostHog connector metadata from Stripe Projects context.', false)
    .action(async (source: string, opts: { projectId: string; host: string; apiKeyEnv: string; eventsFile: string; fromStripeProjects?: boolean }) => {
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
            : defaultPostHogConnector(opts.projectId);
        if (normalizedSource === 'posthog') {
          config.posthog = {
            host: opts.host,
            project_id: opts.projectId,
            api_key_env: opts.apiKeyEnv,
          };
        }
        await fs.writeFile(file, JSON.stringify(config, null, 2) + '\n');
        const shared = await readShared(ctx.getRoot());
        if (shared) {
          shared.connectors[normalizedSource] = {
            status: 'configured',
            config_file: path.relative(ctx.getRoot(), file),
            required_env:
              normalizedSource === 'posthog'
                ? [opts.apiKeyEnv, ...envProjectIds(opts.projectId)]
                : [],
            required_scopes: normalizedSource === 'posthog' ? ['query:read', 'project:read'] : [],
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
        validateConnectorShapes(source ? connectors.filter((c) => c.source === source) : connectors);
        assertCoverage(experiments, connectors);
        return {
          data: {
            ok: true,
            experiments: experiments.length,
            connectors: connectors.length,
          },
          humanText: `Coverage OK across ${experiments.length} experiment(s) and ${connectors.length} connector(s).`,
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
        const apiKeyEnv = c.posthog?.api_key_env ?? (c.kind === 'posthog' ? 'POSTHOG_PERSONAL_API_KEY' : undefined);
        const projectId = c.posthog?.project_id;
        const projectIdPresent =
          isEnvReference(projectId)
            ? !!(await readEnvValue(ctx.getRoot(), projectId))
            : projectId !== undefined;
        const apiKeyPresent = apiKeyEnv ? !!(await readEnvValue(ctx.getRoot(), apiKeyEnv)) : true;
        return {
          data: {
            source: c.source,
            kind: c.kind,
            host: c.posthog?.host,
            project_id_present: projectIdPresent,
            api_key_env: apiKeyEnv,
            api_key_present: apiKeyPresent,
            required_scopes: c.kind === 'posthog' ? ['query:read', 'project:read'] : [],
          },
          humanText: `${source} auth: project_id=${projectIdPresent ? 'present' : 'missing'} api_key=${apiKeyPresent ? 'present' : 'missing'}`,
          nextSteps:
            apiKeyPresent && projectIdPresent
              ? [`growth connector validate ${source} --json`]
              : [`Set ${apiKeyEnv ?? 'the connector API key env var'} and project id, then rerun this command.`],
        };
      });
    });
}

function validateConnectorShapes(connectors: ConnectorConfig[]): void {
  const errors: Array<{ source: string; message: string }> = [];
  for (const c of connectors) {
    for (const key of ['source', 'kind', 'event_name_path', 'user_id_path', 'experiment_id_path', 'variant_id_path']) {
      if (!(c as unknown as Record<string, unknown>)[key]) {
        errors.push({ source: c.source || '(unknown)', message: `missing ${key}` });
      }
    }
    if (!c.mappings || typeof c.mappings !== 'object') {
      errors.push({ source: c.source || '(unknown)', message: 'missing mappings object' });
    }
  }
  if (errors.length) {
    throw new GrowthError('invalid_connector', 'Connector validation failed.', { errors });
  }
}

function envProjectIds(projectId: string): string[] {
  return /^[A-Z][A-Z0-9_]*$/.test(projectId) ? [projectId] : [];
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
  const config = defaultPostHogConnector(imported.projectId);
  config.mappings = shouldPreserveMappings(existing?.mappings) ? existing!.mappings : defaultPostHogMappings();
  config.posthog = {
    host: imported.host,
    project_id: imported.projectId,
    api_key_env: imported.apiKeyEnv,
  };
  await fs.writeFile(file, JSON.stringify(config, null, 2) + '\n');
  const shared = await readShared(root);
  const requiredEnv = [imported.apiKeyEnv];
  if (isEnvReference(imported.projectId)) requiredEnv.push(imported.projectId);
  if (shared) {
    shared.connectors[source] = {
      status: 'configured',
      config_file: path.relative(root, file),
      required_env: requiredEnv,
      required_scopes: ['query:read', 'project:read'],
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
  projectId: string | number;
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

  const partials: Array<{ host: string; projectId?: string | number; apiKeyEnv: string; source_file: string }> = [];
  const matches = found
    .map((candidate) => ({ ...candidate, parsed: safeJson(candidate.text) }))
    .map((candidate) => {
      const envCandidate = findPostHogEnvCandidate(candidate.text, path.relative(root, candidate.file));
      if (envCandidate) {
        if (envCandidate.projectId !== undefined) {
          return envCandidate as { host: string; projectId: string | number; apiKeyEnv: string; source_file: string };
        }
        partials.push(envCandidate);
        return null;
      }
      const text = candidate.text;
      const projectId =
        findString(candidate.parsed, ['POSTHOG_PROJECT_ID', 'POSTHOG_PROJECT', 'project_id_env']) ??
        (text.includes('POSTHOG_PROJECT_ID') ? 'POSTHOG_PROJECT_ID' : undefined);
      const apiKeyEnv =
        findString(candidate.parsed, ['POSTHOG_PERSONAL_API_KEY', 'POSTHOG_API_KEY', 'api_key_env']) ??
        (text.includes('POSTHOG_PERSONAL_API_KEY') ? 'POSTHOG_PERSONAL_API_KEY' : undefined);
      const host =
        findUrl(candidate.parsed, 'posthog') ??
        (text.includes('eu.posthog.com') ? 'https://eu.posthog.com' : 'https://us.posthog.com');
      return projectId && apiKeyEnv
        ? {
            host,
            projectId,
            apiKeyEnv,
            source_file: path.relative(root, candidate.file),
          }
        : null;
    })
    .filter((candidate): candidate is { host: string; projectId: string | number; apiKeyEnv: string; source_file: string } => !!candidate);

  if (matches.length === 0 && partials.length > 0) {
    const projectId = await discoverPostHogProjectIdFromStripeOpen(root);
    if (projectId !== undefined) {
      const preferred = partials[0];
      matches.push({
        ...preferred,
        projectId,
        source_file: `${preferred.source_file} + stripe projects open posthog --json`,
      });
    }
  }

  if (matches.length === 0) {
    throw new GrowthError('posthog_context_not_found', 'Stripe Projects metadata did not include PostHog env names.', {
      checked: found.map((candidate) => path.relative(root, candidate.file)),
      hint: partials.length
        ? 'PostHog env names were found, but no PostHog project id was available. Run `stripe projects open posthog --json` or set POSTHOG_ANALYTICS_PROJECT_ID.'
        : undefined,
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
  const bases = ['POSTHOG_ANALYTICS', 'POSTHOG', 'POSTHOG_PLAN'];
  for (const base of bases) {
    const apiKeyEnv = `${base}_PERSONAL_API_KEY`;
    if (!(apiKeyEnv in env)) continue;
    const projectIdEnv = `${base}_PROJECT_ID`;
    const projectId = projectIdEnv in env ? projectIdEnv : 'POSTHOG_PROJECT_ID' in env ? 'POSTHOG_PROJECT_ID' : undefined;
    return {
      host: env[`${base}_HOST`] ?? env.POSTHOG_HOST ?? 'https://us.posthog.com',
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

function defaultPostHogMappings(): ConnectorConfig['mappings'] {
  return Object.fromEntries(
    DEFAULT_EVENT_TAXONOMY.events.map((event) => [
      event.event,
      {
        payload_paths: {
          agent_generated: 'properties.agent_generated',
          agent_run_id: 'properties.agent_run_id',
          session_id: 'properties.session_id',
        },
      },
    ]),
  );
}

async function discoverPostHogProjectIdFromStripeOpen(root: string): Promise<number | undefined> {
  try {
    const { stdout } = await execFileAsync('stripe', ['projects', 'open', 'posthog', '--json'], {
      cwd: root,
      timeout: 15_000,
      maxBuffer: 1024 * 1024,
    });
    const parsed = safeJson(stdout);
    const url = findString(parsed, ['url']);
    if (!url) return undefined;
    const dashboardUrl = new URL(url);
    const env = await readLocalEnv(root);
    const projectTokens = new Set(
      Object.entries(env)
        .filter(([key, value]) => /^POSTHOG(?:_[A-Z]+)*_API_KEY$/.test(key) && !key.includes('PERSONAL') && value)
        .map(([, value]) => value),
    );
    const projectIdByToken = await discoverPostHogProjectIdByToken(dashboardUrl, projectTokens);
    if (projectIdByToken !== undefined) return projectIdByToken;

    const teamId = dashboardUrl.searchParams.get('team_id');
    return teamId && /^\d+$/.test(teamId) ? Number(teamId) : undefined;
  } catch {
    return undefined;
  }
}

async function discoverPostHogProjectIdByToken(
  dashboardUrl: URL,
  projectTokens: Set<string>,
): Promise<number | undefined> {
  if (projectTokens.size === 0) return undefined;
  const login = await fetch(dashboardUrl, { redirect: 'manual' });
  const getSetCookie = (login.headers as Headers & { getSetCookie?: () => string[] }).getSetCookie;
  const cookies = getSetCookie ? getSetCookie.call(login.headers) : [];
  if (cookies.length === 0) return undefined;

  const projects = await fetch(new URL('/api/projects/', dashboardUrl.origin), {
    headers: { Cookie: cookies.map((cookie) => cookie.split(';')[0]).join('; ') },
  });
  if (!projects.ok) return undefined;
  const body = (await projects.json()) as { results?: Array<{ id?: unknown; api_token?: unknown }> };
  for (const project of body.results ?? []) {
    if (typeof project.id === 'number' && typeof project.api_token === 'string' && projectTokens.has(project.api_token)) {
      return project.id;
    }
  }
  return undefined;
}

function isEnvReference(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Z_][A-Z0-9_]*$/.test(value);
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
