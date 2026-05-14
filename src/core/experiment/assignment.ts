import { createHash } from 'node:crypto';
import type { Variant } from './types.js';

/**
 * Hash-based deterministic assignment. Same (experimentId, userId) always
 * returns the same variant; weights act as proportions of the 0..1 hash output.
 */
export function assignVariant(
  experimentId: string,
  userId: string,
  variants: Variant[],
): Variant {
  if (variants.length === 0) throw new Error('no variants defined');

  const totalWeight = variants.reduce((s, v) => s + v.weight, 0);
  if (totalWeight <= 0) throw new Error('variant weights must sum > 0');

  const hash = createHash('sha256').update(`${experimentId}:${userId}`).digest('hex').slice(0, 8);
  const bucket = parseInt(hash, 16) / 0xffffffff;

  let cumulative = 0;
  for (const v of variants) {
    cumulative += v.weight / totalWeight;
    if (bucket < cumulative) return v;
  }
  return variants[variants.length - 1];
}

export function isInVariant(
  experimentId: string,
  userId: string,
  variants: Variant[],
  variantId: string,
): boolean {
  return assignVariant(experimentId, userId, variants).id === variantId;
}
