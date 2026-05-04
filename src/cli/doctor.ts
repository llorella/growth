import type { Command } from 'commander';
import type { Dirent } from 'node:fs';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { wrap, type RunCtx } from '../lib/runner.js';
import { isInitialized } from '../lib/state.js';
import { Store } from '../lib/store.js';
import { listConnectors, assertCoverage } from '../lib/connectors.js';
import { detectFramework, suggestedInstrumentationFiles } from '../lib/framework.js';
import { paths } from '../lib/paths.js';

type CheckStatus = 'pass' | 'warn' | 'fail';

interface DoctorCheck {
  name: string;
  status: CheckStatus;
  message: string;
  details?: Record<string, unknown>;
}

export function registerDoctor(program: Command, ctx: RunCtx): void {
  program
    .command('doctor')
    .description('Check growth setup, connector coverage, instrumentation hints, and recent run state.')
    .argument('[experiment_id]', 'Optional experiment to focus checks on.')
    .action(async (experimentId?: string) => {
      await wrap('growth doctor', ctx, async () => {
        const root = ctx.getRoot();
        const checks: DoctorCheck[] = [];
        const initialized = await isInitialized(root);
        checks.push({
          name: 'initialized',
          status: initialized ? 'pass' : 'fail',
          message: initialized ? 'growth is initialized.' : 'Run growth init --json.',
        });
        if (!initialized) {
          return doctorResult(checks);
        }

        const store = new Store(root);
        const [experiments, connectors, framework] = await Promise.all([
          store.listExperiments(),
          listConnectors(root),
          detectFramework(root),
        ]);
        const focused = experimentId ? experiments.find((exp) => exp.id === experimentId) : undefined;
        if (experimentId) {
          checks.push({
            name: 'experiment',
            status: focused ? 'pass' : 'fail',
            message: focused ? `Experiment ${experimentId} exists.` : `Experiment ${experimentId} was not found.`,
          });
        } else {
          checks.push({
            name: 'experiments',
            status: experiments.length ? 'pass' : 'warn',
            message: experiments.length
              ? `${experiments.length} experiment(s) configured.`
              : 'No experiments configured yet.',
          });
        }

        checks.push({
          name: 'connectors',
          status: connectors.length ? 'pass' : 'warn',
          message: connectors.length
            ? `${connectors.length} connector(s) configured.`
            : 'No connectors configured. Add one with growth connector add local --json.',
        });

        if (connectors.length && (focused || experiments.length)) {
          try {
            assertCoverage(focused ? [focused] : experiments, connectors);
            checks.push({
              name: 'connector_coverage',
              status: 'pass',
              message: 'Configured connectors cover required active experiment events.',
            });
          } catch (err) {
            checks.push({
              name: 'connector_coverage',
              status: 'fail',
              message: err instanceof Error ? err.message : String(err),
            });
          }
        }

        const suggestedFiles = await suggestedInstrumentationFiles(root, framework);
        const existingSuggestedFiles = [];
        for (const file of suggestedFiles) {
          try {
            await fs.access(path.join(root, file));
            existingSuggestedFiles.push(file);
          } catch {
            // reported below
          }
        }
        checks.push({
          name: 'instrumentation_files',
          status: existingSuggestedFiles.length ? 'pass' : 'warn',
          message: existingSuggestedFiles.length
            ? `${existingSuggestedFiles.length} suggested instrumentation file(s) exist.`
            : 'No suggested instrumentation files found. Existing app-specific paths may still be valid.',
          details: { framework, suggested_files: suggestedFiles, existing_suggested_files: existingSuggestedFiles },
        });

        const recentRuns = await listRecentRuns(root);
        checks.push({
          name: 'runs',
          status: recentRuns.length ? 'pass' : 'warn',
          message: recentRuns.length ? `${recentRuns.length} recent run(s) found.` : 'No growth runs found yet.',
          details: { recent_runs: recentRuns },
        });

        return doctorResult(checks);
      });
    });
}

function doctorResult(checks: DoctorCheck[]) {
  const fail = checks.filter((check) => check.status === 'fail').length;
  const warn = checks.filter((check) => check.status === 'warn').length;
  return {
    data: {
      ok: fail === 0,
      summary: { pass: checks.length - fail - warn, warn, fail },
      checks,
    },
    warnings: checks
      .filter((check) => check.status === 'warn')
      .map((check) => ({ code: `DOCTOR_${check.name.toUpperCase()}`, message: check.message })),
    humanText: checks.map((check) => `${check.status.padEnd(4)} ${check.name}: ${check.message}`).join('\n'),
    nextSteps:
      fail || warn
        ? [
            'Run growth status --json for current state.',
            'Run growth instrumentation plan <experiment_id> --json before editing app code.',
          ]
        : ['Run growth llm-context --json before the next experiment step.'],
  };
}

async function listRecentRuns(root: string): Promise<Array<{ id: string; status?: string; type?: string }>> {
  const out: Array<{ id: string; status?: string; type?: string }> = [];
  let dirs: Dirent[] = [];
  try {
    dirs = await fs.readdir(paths(root).runsDir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const dir of dirs) {
    if (!dir.isDirectory()) continue;
    try {
      const run = JSON.parse(await fs.readFile(path.join(paths(root).runsDir, dir.name, 'run.json'), 'utf8')) as {
        id?: string;
        status?: string;
        type?: string;
      };
      out.push({ id: run.id ?? dir.name, status: run.status, type: run.type });
    } catch {
      out.push({ id: dir.name });
    }
  }
  return out.sort((a, b) => b.id.localeCompare(a.id)).slice(0, 5);
}
