import { isInitialized } from './state.js';
import { GrowthError } from './envelope.js';

export async function requireInitialized(root: string): Promise<void> {
  if (!(await isInitialized(root))) {
    throw new GrowthError(
      'not_initialized',
      'growth is not initialized in this directory. Run `growth init` first.',
      { root },
    );
  }
}
