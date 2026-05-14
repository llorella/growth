import { GrowthError } from '../lib/envelope.js';
import {
  normalizeFrameworkId,
  supportedFrameworkIds,
  type FrameworkId,
} from '../lib/framework.js';

export function parseFrameworkOption(value: string): FrameworkId {
  const framework = normalizeFrameworkId(value);
  if (!framework) {
    throw new GrowthError('unsupported_framework', `Framework "${value}" is not supported.`, {
      supported: supportedFrameworkIds(),
    });
  }
  return framework;
}
