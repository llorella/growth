import type { Targeting, TargetingRule } from './types.js';

/**
 * Targeting engine: AND-combined rules; empty array matches everyone.
 * Field paths support dot notation: "device.platform", "utm.source".
 */
export function matchesTargeting(
  targeting: Targeting | undefined,
  context: Record<string, unknown>,
): boolean {
  if (!targeting || !targeting.rules || targeting.rules.length === 0) return true;
  return targeting.rules.every((rule) => evaluateRule(rule, context));
}

function evaluateRule(rule: TargetingRule, context: Record<string, unknown>): boolean {
  const fieldValue = readPath(context, rule.field);

  switch (rule.op) {
    case 'equals':
      return fieldValue === rule.value;
    case 'not_equals':
      return fieldValue !== rule.value;
    case 'in':
      return Array.isArray(rule.value) && (rule.value as unknown[]).includes(fieldValue);
    case 'not_in':
      return Array.isArray(rule.value) && !(rule.value as unknown[]).includes(fieldValue);
    case 'contains':
      return typeof fieldValue === 'string' && fieldValue.includes(String(rule.value));
    case 'matches':
      try {
        return typeof fieldValue === 'string' && new RegExp(String(rule.value)).test(fieldValue);
      } catch {
        return false;
      }
    default:
      return false;
  }
}

function readPath(obj: Record<string, unknown>, path: string): unknown {
  return path
    .split('.')
    .reduce<unknown>(
      (acc, key) =>
        acc && typeof acc === 'object' ? (acc as Record<string, unknown>)[key] : undefined,
      obj,
    );
}
