import { GrowthError } from '../../lib/envelope.js';
import { pull } from '../../lib/pull.js';

export interface PullExperimentCommandOptions {
  source: string;
  after?: string;
  before?: string;
  limit?: number;
  allowOverlap?: boolean;
}

export async function pullExperimentCommand(
  root: string,
  experimentId: string,
  opts: PullExperimentCommandOptions,
) {
  if (!opts.source) {
    throw new GrowthError('missing_source', 'pull requires --source <name>.');
  }
  const result = await pull(root, {
    experimentId,
    source: opts.source,
    after: opts.after,
    before: opts.before,
    limit: opts.limit,
    allowOverlap: opts.allowOverlap === true,
  });
  return {
    data: result,
    humanText: [
      `Pulled ${experimentId} from ${result.source} window ${result.window.after} -> ${result.window.before}`,
      `  raw: ${result.raw_fetched}  emitted: ${result.emitted}  deduped: ${result.deduped}`,
      `  dropped: ${result.dropped.map((d) => `${d.reason}=${d.count}`).join(', ') || 'none'}`,
    ].join('\n'),
    nextSteps: [`growth preflight plan ${experimentId} --json`],
  };
}
