import type { Command } from 'commander';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { wrap, type RunCtx } from '../lib/runner.js';
import {
  isInitialized,
  newSharedState,
  writeShared,
  writeLocal,
  paths,
} from '../lib/state.js';
import { writeSkill } from '../lib/skill.js';
import { detectFramework } from '../lib/framework.js';
import { DEFAULT_EVENT_TAXONOMY } from '../lib/defaults.js';

const DOT_GITIGNORE = `# growth local-only artifacts
state.local.json
audit.jsonl
data/
runs/*/secrets/
`;

export function registerInit(program: Command, ctx: RunCtx): void {
  program
    .command('init')
    .description('Initialize growth in this directory.')
    .option('--framework <id>', 'Override framework detection.')
    .option('--bare', 'Only create .growth state; skip agent guidance.')
    .action(async (opts: { framework?: string; bare?: boolean }) => {
      await wrap('growth init', ctx, async () => {
        const root = ctx.getRoot();
        const p = paths(root);
        const already = await isInitialized(root);
        const framework = opts.framework ?? (await detectFramework(root));

        await fs.mkdir(p.dot, { recursive: true });
        await fs.mkdir(p.dataDir, { recursive: true });
        await fs.mkdir(p.experimentsDir, { recursive: true });
        await fs.mkdir(p.templatesDir, { recursive: true });
        await fs.mkdir(p.connectorsDir, { recursive: true });
        await fs.mkdir(p.runsDir, { recursive: true });

        if (!already) {
          await writeShared(root, newSharedState(path.basename(root), framework));
          await writeLocal(root, {
            env_files: ['.env.local', '.env'],
          });
        }
        await fs.writeFile(p.dotGitignore, DOT_GITIGNORE);
        await seedEventTaxonomy(root);
        await upsertRootGitignore(root);

        const skill = opts.bare ? { wrote: [] } : await writeSkill(root);

        return {
          data: {
            root,
            framework,
            framework_hint: { detected: framework, advisory_only: true },
            reinitialized: already,
            wrote: {
              dot: p.dot,
              experiments: p.experimentsDir,
              templates: p.templatesDir,
              connectors: p.connectorsDir,
              event_taxonomy: p.eventTaxonomyFile,
              skills: skill.wrote,
            },
          },
          humanText: already
            ? `growth is already initialized at ${root}.`
            : `growth initialized at ${root}.`,
          nextSteps: already
            ? []
            : [
                'growth status --json',
                'growth schema experiment --json',
                'growth template list --json',
                'growth experiment create <id> --from-file <spec.json> --json',
              ],
          next: already
            ? {
                command: 'growth status --json',
                until: 'current growth state is inspected before making further changes',
              }
            : {
                command: 'growth status --json',
                until: 'initialized project state is inspected before authoring an experiment',
              },
        };
      });
    });
}

async function seedEventTaxonomy(root: string): Promise<void> {
  const p = paths(root);
  try {
    await fs.access(p.eventTaxonomyFile);
  } catch {
    await fs.writeFile(p.eventTaxonomyFile, JSON.stringify(DEFAULT_EVENT_TAXONOMY, null, 2) + '\n');
  }
}

async function upsertRootGitignore(root: string): Promise<void> {
  const p = paths(root);
  const block = [
    '# growth local state',
    '.env',
    '.env.*',
    '!.env.example',
    '.growth/state.local.json',
    '.growth/audit.jsonl',
    '.growth/data/',
    '.growth/runs/*/secrets/',
    '',
  ].join('\n');
  let current = '';
  try {
    current = await fs.readFile(p.rootGitignore, 'utf8');
  } catch {
    // create below
  }
  if (!current.includes('.growth/state.local.json')) {
    await fs.writeFile(p.rootGitignore, `${current}${current && !current.endsWith('\n') ? '\n' : ''}${block}`);
  }
}
