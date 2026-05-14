import { promises as fs } from 'node:fs';
import path from 'node:path';

export const FRAMEWORK_IDS = [
  'nextjs-app-router',
  'nextjs-pages-router',
  'react-vite',
  'remix',
  'astro',
  'sveltekit',
  'rails',
  'django',
  'flask-fastapi',
  'generic-node',
  'unknown',
] as const;

export type FrameworkId = (typeof FRAMEWORK_IDS)[number];

const FRAMEWORK_ALIASES: Record<string, FrameworkId> = {
  next: 'nextjs-app-router',
  nextjs: 'nextjs-app-router',
  'nextjs-app': 'nextjs-app-router',
  'next-app': 'nextjs-app-router',
  'nextjs-pages': 'nextjs-pages-router',
  'next-pages': 'nextjs-pages-router',
  vite: 'react-vite',
  'vite-react': 'react-vite',
  flask: 'flask-fastapi',
  fastapi: 'flask-fastapi',
};

export function isFrameworkId(value: unknown): value is FrameworkId {
  return typeof value === 'string' && FRAMEWORK_IDS.includes(value as FrameworkId);
}

export function normalizeFrameworkId(value: string | undefined): FrameworkId | undefined {
  const key = value?.trim().toLowerCase();
  if (!key) return undefined;
  if (isFrameworkId(key)) return key;
  return FRAMEWORK_ALIASES[key];
}

export function supportedFrameworkIds(): FrameworkId[] {
  return [...FRAMEWORK_IDS];
}

async function exists(file: string): Promise<boolean> {
  try {
    await fs.access(file);
    return true;
  } catch {
    return false;
  }
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
