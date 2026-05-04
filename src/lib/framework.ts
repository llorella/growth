import { promises as fs } from 'node:fs';
import path from 'node:path';

export type FrameworkId =
  | 'nextjs-app-router'
  | 'nextjs-pages-router'
  | 'react-vite'
  | 'remix'
  | 'astro'
  | 'sveltekit'
  | 'rails'
  | 'django'
  | 'flask-fastapi'
  | 'generic-node'
  | 'unknown';

async function exists(file: string): Promise<boolean> {
  try {
    await fs.access(file);
    return true;
  } catch {
    return false;
  }
}

async function readJson(file: string): Promise<Record<string, unknown> | null> {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8')) as Record<string, unknown>;
  } catch {
    return null;
  }
}

export async function detectFramework(root: string): Promise<FrameworkId> {
  const pkg = await readJson(path.join(root, 'package.json'));
  const deps = {
    ...((pkg?.dependencies as Record<string, unknown> | undefined) ?? {}),
    ...((pkg?.devDependencies as Record<string, unknown> | undefined) ?? {}),
  };

  if (deps.next || (await exists(path.join(root, 'next.config.js'))) || (await exists(path.join(root, 'next.config.ts')))) {
    if (await exists(path.join(root, 'src', 'app'))) return 'nextjs-app-router';
    if (await exists(path.join(root, 'app'))) return 'nextjs-app-router';
    if (await exists(path.join(root, 'src', 'pages'))) return 'nextjs-pages-router';
    if (await exists(path.join(root, 'pages'))) return 'nextjs-pages-router';
    return 'nextjs-app-router';
  }
  if (deps.vite && deps.react) return 'react-vite';
  if (deps['@remix-run/react']) return 'remix';
  if (deps.astro) return 'astro';
  if (deps['@sveltejs/kit']) return 'sveltekit';
  if (await exists(path.join(root, 'config', 'application.rb'))) return 'rails';
  if (await exists(path.join(root, 'manage.py'))) return 'django';
  if (await exists(path.join(root, 'pyproject.toml')) || await exists(path.join(root, 'requirements.txt'))) {
    return 'flask-fastapi';
  }
  if (pkg) return 'generic-node';
  return 'unknown';
}

export async function suggestedInstrumentationFiles(root: string, framework: FrameworkId): Promise<string[]> {
  switch (framework) {
    case 'nextjs-app-router': {
      const appDir = await firstExisting(root, ['src/app', 'app'], 'src/app');
      const libFallback = appDir.startsWith('src/') ? 'src/lib' : 'lib';
      const hooksFallback = appDir.startsWith('src/') ? 'src/hooks' : 'hooks';
      const libDir = await firstExisting(root, [`${appDir}/utils`, 'src/lib', 'lib'], libFallback);
      const hooksDir = await firstExisting(root, ['src/hooks', 'hooks'], hooksFallback);
      return [
        `${libDir}/events.ts`,
        `${appDir}/api/events/route.ts`,
        `${libDir}/assignment.ts`,
        `${hooksDir}/useExperiment.ts`,
      ];
    }
    case 'nextjs-pages-router': {
      const pagesDir = await firstExisting(root, ['src/pages', 'pages'], 'src/pages');
      const libFallback = pagesDir.startsWith('src/') ? 'src/lib' : 'lib';
      const hooksFallback = pagesDir.startsWith('src/') ? 'src/hooks' : 'hooks';
      const libDir = await firstExisting(root, ['src/lib', 'lib', 'src/utils', 'utils'], libFallback);
      const hooksDir = await firstExisting(root, ['src/hooks', 'hooks'], hooksFallback);
      return [
        `${libDir}/events.ts`,
        `${pagesDir}/api/events.ts`,
        `${libDir}/assignment.ts`,
        `${hooksDir}/useExperiment.ts`,
      ];
    }
    case 'react-vite':
      return ['src/lib/events.ts', 'src/lib/assignment.ts'];
    case 'remix':
      return ['app/lib/events.ts', 'app/routes/api.events.ts', 'app/lib/assignment.ts'];
    case 'rails':
      return ['app/services/growth_events.rb', 'app/controllers/events_controller.rb'];
    case 'django':
      return ['growth/events.py', 'growth/views.py'];
    case 'flask-fastapi':
      return ['app/events.py', 'app/main.py'];
    default:
      return ['src/lib/events.ts', 'src/lib/assignment.ts'];
  }
}

async function firstExisting(root: string, candidates: string[], fallback: string): Promise<string> {
  for (const candidate of candidates) {
    if (await exists(path.join(root, candidate))) return candidate;
  }
  return fallback;
}
