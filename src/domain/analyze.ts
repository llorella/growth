import type { AnalysisResult, AnalysisSegment, Experiment } from './types.js';
import { buildAnalysis } from './analysis-policy.js';
import type { Store } from '../lib/store.js';

export async function analyzeExperiment(
  store: Store,
  experiment: Experiment,
  segment: AnalysisSegment = 'real-users',
): Promise<AnalysisResult> {
  const [events, assignments] = await Promise.all([
    store.readEvents(experiment.id),
    store.readAssignments(experiment.id),
  ]);

  return buildAnalysis({
    experiment,
    events,
    assignments,
    segment,
  });
}
