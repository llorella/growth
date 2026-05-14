import type { ExperimentEvent } from '../experiment/types.js';

export const SYNTHETIC_TRAFFIC_FIELDS = {
  agentGenerated: 'agent_generated',
  agentRunId: 'agent_run_id',
  experimentId: 'experiment_id',
  forcedVariant: 'variant',
  variantId: 'variant_id',
} as const;

export const SYNTHETIC_TRAFFIC_REQUIRED_PROPERTIES = [
  SYNTHETIC_TRAFFIC_FIELDS.agentGenerated,
  SYNTHETIC_TRAFFIC_FIELDS.agentRunId,
] as const;

export const SYNTHETIC_TRAFFIC_QUERY_PARAMS = [
  {
    name: SYNTHETIC_TRAFFIC_FIELDS.agentGenerated,
    value: 'true',
    meaning: 'Marks browser-agent traffic so it stays separate from real users.',
  },
  {
    name: SYNTHETIC_TRAFFIC_FIELDS.agentRunId,
    value: '<preflight_run_id>_agent_<n>',
    meaning: 'Stable synthetic run id. Preserve it on every emitted event.',
  },
  {
    name: SYNTHETIC_TRAFFIC_FIELDS.experimentId,
    value: '<experiment_id>',
    meaning: 'Experiment being exercised by the preflight packet.',
  },
  {
    name: SYNTHETIC_TRAFFIC_FIELDS.forcedVariant,
    value: '<variant_id>',
    meaning: 'Synthetic preflight packets may force a variant to balance test coverage.',
  },
] as const;

export const SYNTHETIC_TRAFFIC_PAYLOAD_PATHS = {
  [SYNTHETIC_TRAFFIC_FIELDS.agentGenerated]: 'properties.agent_generated',
  [SYNTHETIC_TRAFFIC_FIELDS.agentRunId]: 'properties.agent_run_id',
} as const;

export type TrafficKind = 'real-user' | 'synthetic';

export function buildSyntheticTrafficUrl(
  appUrl: string,
  experimentId: string,
  agentRunId: string,
  variantId?: string,
): string {
  const url = new URL(appUrl);
  url.searchParams.set(SYNTHETIC_TRAFFIC_FIELDS.agentGenerated, 'true');
  url.searchParams.set(SYNTHETIC_TRAFFIC_FIELDS.agentRunId, agentRunId);
  url.searchParams.set(SYNTHETIC_TRAFFIC_FIELDS.experimentId, experimentId);
  if (variantId) url.searchParams.set(SYNTHETIC_TRAFFIC_FIELDS.forcedVariant, variantId);
  return url.toString();
}

export function classifyTraffic(event: Pick<ExperimentEvent, 'payload'>): TrafficKind {
  return isSyntheticEvent(event) ? 'synthetic' : 'real-user';
}

export function isSyntheticEvent(event: Pick<ExperimentEvent, 'payload'>): boolean {
  return event.payload?.[SYNTHETIC_TRAFFIC_FIELDS.agentGenerated] === true;
}

export function isRealUserEvent(event: Pick<ExperimentEvent, 'payload'>): boolean {
  return !isSyntheticEvent(event);
}

export function syntheticAgentRunId(event: Pick<ExperimentEvent, 'payload'>): string | null {
  const value = event.payload?.[SYNTHETIC_TRAFFIC_FIELDS.agentRunId];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

export function hasSyntheticTrafficLabels(event: Pick<ExperimentEvent, 'payload'>): boolean {
  return isSyntheticEvent(event) && syntheticAgentRunId(event) !== null;
}

export function isInSyntheticAgentScope(
  event: Pick<ExperimentEvent, 'payload'>,
  agentIds: Set<string>,
): boolean {
  if (agentIds.size === 0) return true;
  const agentRunId = syntheticAgentRunId(event);
  return agentRunId === null || agentIds.has(agentRunId);
}
