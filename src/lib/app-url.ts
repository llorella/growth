import type { FrameworkId } from './framework.js';
import { patchLocal, readLocal } from './state.js';

export function defaultAppUrlForFramework(framework: FrameworkId | string): string {
  switch (framework) {
    case 'react-vite':
    case 'remix':
    case 'sveltekit':
      return 'http://localhost:5173';
    case 'astro':
      return 'http://localhost:4321';
    case 'django':
      return 'http://localhost:8000';
    case 'flask-fastapi':
      return 'http://localhost:5000';
    case 'rails':
    case 'nextjs-app-router':
    case 'nextjs-pages-router':
    case 'generic-node':
    case 'unknown':
    default:
      return 'http://localhost:3000';
  }
}

export async function resolveAppUrl(root: string, framework: FrameworkId | string, explicit?: string): Promise<string> {
  if (explicit) {
    await patchLocal(root, (state) => ({
      ...state,
      local_servers: {
        ...(state.local_servers ?? {}),
        app_url: explicit,
      },
    }));
    return explicit;
  }
  const local = await readLocal(root);
  return local.local_servers?.app_url ?? defaultAppUrlForFramework(framework);
}
