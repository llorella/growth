/**
 * Two state files:
 *   .growth/state.json        - committed; tells anyone with the repo it's growth-managed
 *   .growth/state.local.json  - gitignored; machine-local cursors and prefs
 */
import { promises as fs } from 'node:fs';
import type { ProjectProfile } from './project-profile.js';
import { paths, type Paths } from './paths.js';

export interface SharedState {
  version: string;
  project: {
    name: string;
    framework: string;
    profile?: ProjectProfile;
    initialized_at: string;
  };
  connectors: Record<
    string,
    {
      status: 'configured' | 'missing_auth' | 'unknown';
      config_file: string;
      required_env: string[];
      required_scopes: string[];
    }
  >;
  experiments: Record<
    string,
    {
      file: string;
      status: string;
      last_analysis_at?: string | null;
    }
  >;
  initialized_at: string;
}

export interface LocalState {
  /** ISO timestamp of last successful pull, per connector. */
  last_pulled?: Record<string, string>;
  env_files?: string[];
  local_servers?: {
    app_url?: string;
  };
}

const SHARED_VERSION = '0.1';

async function readJsonOrNull<T>(file: string): Promise<T | null> {
  try {
    const text = await fs.readFile(file, 'utf8');
    return JSON.parse(text) as T;
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

export async function isInitialized(root: string): Promise<boolean> {
  const p = paths(root);
  return (await readJsonOrNull<SharedState>(p.stateFile)) !== null;
}

export async function readShared(root: string): Promise<SharedState | null> {
  return readJsonOrNull<SharedState>(paths(root).stateFile);
}

export async function readLocal(root: string): Promise<LocalState> {
  const data = await readJsonOrNull<LocalState>(paths(root).stateLocalFile);
  return data ?? {};
}

export async function writeShared(root: string, state: SharedState): Promise<void> {
  const p = paths(root);
  await fs.mkdir(p.dot, { recursive: true });
  await fs.writeFile(p.stateFile, JSON.stringify(state, null, 2) + '\n');
}

export async function writeLocal(root: string, state: LocalState): Promise<void> {
  const p = paths(root);
  await fs.mkdir(p.dot, { recursive: true });
  await fs.writeFile(p.stateLocalFile, JSON.stringify(state, null, 2) + '\n');
}

export async function patchLocal(
  root: string,
  patch: (s: LocalState) => LocalState,
): Promise<LocalState> {
  const cur = await readLocal(root);
  const next = patch(cur);
  await writeLocal(root, next);
  return next;
}

export function newSharedState(projectName: string, framework: string): SharedState {
  const initializedAt = new Date().toISOString();
  return {
    version: SHARED_VERSION,
    project: {
      name: projectName,
      framework,
      profile: {
        schema_version: 1,
        framework: {
          id: framework,
          source: 'init',
        },
        app_urls: {},
        routes: [],
        auth_contexts: [],
      },
      initialized_at: initializedAt,
    },
    connectors: {},
    experiments: {},
    initialized_at: initializedAt,
  };
}

export { paths };
export type { Paths };
export type { LocalState as LocalStateType };
