import { GrowthError } from './envelope.js';
import { isFrameworkId, normalizeFrameworkId } from './framework.js';
import { readShared, writeShared, type SharedState } from './state.js';

export type ProjectFactSource = 'user' | 'init' | 'import' | 'experiment' | 'legacy_state';

export interface ProjectProfileFact {
  source: ProjectFactSource;
}

export interface ProjectFramework extends ProjectProfileFact {
  id: string;
}

export interface ProjectRoute extends ProjectProfileFact {
  id: string;
  path: string;
}

export interface ProjectAuthContext extends ProjectProfileFact {
  id: string;
  requires_session: boolean;
}

export interface ProjectProfile {
  schema_version: 1;
  framework?: ProjectFramework;
  app_urls: {
    default?: string;
    [name: string]: string | undefined;
  };
  routes: ProjectRoute[];
  auth_contexts: ProjectAuthContext[];
}

export interface ProjectUnknown {
  fact: string;
  reason: string;
  next_command: string;
}

export function emptyProjectProfile(): ProjectProfile {
  return {
    schema_version: 1,
    app_urls: {},
    routes: [],
    auth_contexts: [],
  };
}

export function projectProfileFromShared(shared: SharedState | null): ProjectProfile {
  const raw = shared?.project.profile;
  const profile = normalizeProjectProfile(raw);
  if (!profile.framework && shared?.project.framework) {
    profile.framework = {
      id: shared.project.framework,
      source: 'legacy_state',
    };
  }
  return profile;
}

export async function readProjectProfile(root: string): Promise<ProjectProfile> {
  return projectProfileFromShared(await readShared(root));
}

export async function patchProjectProfile(
  root: string,
  patch: (profile: ProjectProfile, shared: SharedState) => ProjectProfile,
): Promise<ProjectProfile> {
  const shared = await readShared(root);
  if (!shared) {
    throw new GrowthError('not_initialized', 'Run `growth init` before configuring the project profile.');
  }
  const current = projectProfileFromShared(shared);
  const next = normalizeProjectProfile(patch(current, shared));
  shared.project.profile = next;
  if (next.framework?.id) shared.project.framework = next.framework.id;
  await writeShared(root, shared);
  return next;
}

export function projectProfileUnknowns(profile: ProjectProfile): ProjectUnknown[] {
  const unknowns: ProjectUnknown[] = [];
  if (!profile.framework?.id || profile.framework.id === 'unknown') {
    unknowns.push({
      fact: 'framework',
      reason: 'Project framework is not configured in Growth project profile.',
      next_command: 'growth project configure --framework <id> --json',
    });
  } else if (!isFrameworkId(profile.framework.id)) {
    unknowns.push({
      fact: 'framework',
      reason: `Project framework "${profile.framework.id}" is not a supported Growth framework id.`,
      next_command: 'growth project configure --framework <id> --json',
    });
  }
  if (!profile.app_urls.default) {
    unknowns.push({
      fact: 'app_urls.default',
      reason: 'Default app URL is not configured in Growth project profile.',
      next_command: 'growth project configure --app-url <url> --json',
    });
  }
  return unknowns;
}

export function upsertProjectRoute(profile: ProjectProfile, route: ProjectRoute): ProjectProfile {
  const routes = profile.routes.filter((candidate) => candidate.id !== route.id);
  routes.push(route);
  return { ...profile, routes };
}

export function upsertProjectAuthContext(
  profile: ProjectProfile,
  authContext: ProjectAuthContext,
): ProjectProfile {
  const authContexts = profile.auth_contexts.filter((candidate) => candidate.id !== authContext.id);
  authContexts.push(authContext);
  return { ...profile, auth_contexts: authContexts };
}

function normalizeProjectProfile(raw: ProjectProfile | undefined): ProjectProfile {
  const rawFrameworkId = raw?.framework?.id ? String(raw.framework.id) : undefined;
  const frameworkId = normalizeFrameworkId(rawFrameworkId) ?? rawFrameworkId;
  return {
    schema_version: 1,
    ...(frameworkId
      ? {
          framework: {
            id: frameworkId,
            source: normalizeSource(raw?.framework?.source),
          },
        }
      : {}),
    app_urls: normalizeAppUrls(raw?.app_urls),
    routes: normalizeRoutes(raw?.routes),
    auth_contexts: normalizeAuthContexts(raw?.auth_contexts),
  };
}

function normalizeAppUrls(raw: ProjectProfile['app_urls'] | undefined): ProjectProfile['app_urls'] {
  const out: ProjectProfile['app_urls'] = {};
  for (const [key, value] of Object.entries(raw ?? {})) {
    if (typeof value === 'string' && value.trim()) out[key] = value;
  }
  return out;
}

function normalizeRoutes(raw: ProjectRoute[] | undefined): ProjectRoute[] {
  return (raw ?? [])
    .filter((route) => route && typeof route.id === 'string' && typeof route.path === 'string')
    .map((route) => ({
      id: route.id,
      path: normalizeRoutePath(route.path),
      source: normalizeSource(route.source),
    }));
}

function normalizeAuthContexts(raw: ProjectAuthContext[] | undefined): ProjectAuthContext[] {
  return (raw ?? [])
    .filter((authContext) => authContext && typeof authContext.id === 'string')
    .map((authContext) => ({
      id: authContext.id,
      requires_session: !!authContext.requires_session,
      source: normalizeSource(authContext.source),
    }));
}

export function normalizeRoutePath(routePath: string): string {
  const trimmed = routePath.trim();
  if (!trimmed) throw new GrowthError('invalid_route_path', 'Route path must not be empty.');
  return trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
}

function normalizeSource(source: ProjectFactSource | undefined): ProjectFactSource {
  return source && ['user', 'init', 'import', 'experiment', 'legacy_state'].includes(source)
    ? source
    : 'user';
}
