import { GrowthError } from '../../lib/envelope.js';
import { readShared, writeShared } from '../../lib/state.js';
import { Store } from '../../lib/store.js';
import type { AnalysisSegment } from '../experiment/types.js';
import { analyzeExperiment } from './analyze.js';

const SEGMENTS = new Set(['all', 'real-users', 'agent-generated']);

export async function analyzeExperimentCommand(root: string, id: string, segment: AnalysisSegment) {
  if (!SEGMENTS.has(segment)) {
    throw new GrowthError('invalid_segment', `Unknown segment "${segment}".`, {
      available: Array.from(SEGMENTS),
    });
  }
  const store = new Store(root);
  const exp = await store.getExperiment(id);
  if (!exp) throw new GrowthError('not_found', `Experiment "${id}" not found.`);
  const result = await analyzeExperiment(store, exp, segment);
  const shared = await readShared(root);
  if (shared?.experiments[id]) {
    shared.experiments[id].last_analysis_at = result.generated_at;
    await writeShared(root, shared);
  }
  return {
    data: result,
    humanText: [
      `Experiment ${id} (${result.status}, ${result.runtime_days}d, ${result.total_users} users, segment=${result.segment})`,
      '',
      `  Recommendation: ${result.recommendation.action} (${result.recommendation.confidence})`,
      `  ${result.recommendation.reasoning}`,
    ].join('\n'),
    nextSteps: result.recommendation.next_steps,
  };
}
