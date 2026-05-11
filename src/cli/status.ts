import type { Command } from 'commander';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { wrap, type RunCtx } from '../lib/runner.js';
import { isInitialized, readShared, paths } from '../lib/state.js';
import { Store } from '../lib/store.js';
import { listConnectors } from '../lib/connectors.js';
import { connectorApiKeyEnv } from '../lib/connector-catalog.js';
import { detectFramework } from '../lib/framework.js';
import { readEnvValue } from '../lib/env-files.js';

async function countLines(file: string): Promise<number> {
  try {
    const text = await fs.readFile(file, 'utf8');
    if (!text) return 0;
    return text.split('\n').filter((l) => l.length > 0).length;
  } catch {
    return 0;
  }
}

async function listRuns(runsDir: string): Promise<Array<{ id: string; status?: string; type?: string }>> {
  try {
    const dirs = await fs.readdir(runsDir, { withFileTypes: true });
    const out: Array<{ id: string; status?: string; type?: string }> = [];
    for (const dir of dirs) {
      if (!dir.isDirectory()) continue;
      try {
        const run = JSON.parse(await fs.readFile(path.join(runsDir, dir.name, 'run.json'), 'utf8')) as {
          id: string;
          status?: string;
          type?: string;
        };
        out.push({ id: run.id, status: run.status, type: run.type });
      } catch {
        out.push({ id: dir.name });
      }
    }
    return out.sort((a, b) => b.id.localeCompare(a.id)).slice(0, 10);
  } catch {
    return [];
  }
}

export function registerStatus(program: Command, ctx: RunCtx): void {
  program
    .command('status')
    .description('Summarize growth initialization, configs, connectors, experiments, and recent runs.')
    .argument('[experiment_id]', 'Optional experiment to inspect.')
    .action(async (experimentId?: string) => {
      await wrap<unknown>('growth status', ctx, async () => {
        const root = ctx.getRoot();
        const p = paths(root);
        const initialized = await isInitialized(root);
        const framework = initialized ? (await readShared(root))?.project.framework ?? (await detectFramework(root)) : await detectFramework(root);

        if (!initialized) {
          return {
            data: {
              initialized,
              root,
              framework,
              framework_hint: { detected: framework, advisory_only: true },
              next_command: 'growth init --json',
            },
            humanText: `growth not initialized at ${root}. Run \`growth init\`.`,
            nextSteps: ['growth init --json'],
            next: {
              command: 'growth init --json',
              until: 'growth state is initialized in the repo',
            },
          };
        }

        const store = new Store(root);
        const [shared, experiments, connectors, templates, assignments, events, runs] =
          await Promise.all([
            readShared(root),
            store.listExperiments(),
            listConnectors(root),
            store.listTemplates(),
            countLines(p.assignmentsFile),
            countLines(p.eventsFile),
            listRuns(p.runsDir),
          ]);

        const experiment = experimentId ? await store.getExperiment(experimentId) : null;
        const connectorReadiness = await Promise.all(connectors.map(async (c) => {
          const apiKeyEnv = connectorApiKeyEnv(c);
          return {
            source: c.source,
            kind: c.kind,
            mapped_events: Object.keys(c.mappings).length,
            auth: apiKeyEnv ? { env: apiKeyEnv, present: !!(await readEnvValue(root, apiKeyEnv)) } : { present: true },
          };
        }));

        const data = {
          initialized,
          root,
          framework,
          framework_hint: { detected: framework, advisory_only: true },
          state: shared,
          counts: {
            experiments: experiments.length,
            templates: templates.length,
            connectors: connectors.length,
            assignments,
            events,
            runs: runs.length,
          },
          connectors: connectorReadiness,
          experiments: experiments.map((e) => ({
            id: e.id,
            name: e.name,
            status: e.status,
            variants: e.variants.length,
            metrics: e.metrics.length,
            started_at: e.started_at,
            stopped_at: e.stopped_at,
          })),
          recent_runs: runs,
          experiment,
        };

        return {
          data,
          humanText: [
            `growth at ${root}`,
            `  framework hint: ${framework}`,
            `  experiments: ${experiments.length}`,
            `  templates:   ${templates.length}`,
            `  connectors:  ${connectors.length}`,
            `  runs:        ${runs.length}`,
            `  events:      ${events}`,
            `  assignments: ${assignments}`,
          ].join('\n'),
          nextSteps:
            experiments.length === 0
              ? ['growth schema experiment --json', 'growth experiment create <id> --from-file <spec.json> --json']
              : ['growth llm-context --json'],
          next:
            experiments.length === 0
              ? {
                  command: 'growth schema experiment --json',
                  until: 'an experiment spec is authored from the schema or an explicit template choice',
                }
              : {
                  command: 'growth llm-context --json',
                  until: 'agent has current experiment, connector, and preflight context',
                },
        };
      });
    });
}
