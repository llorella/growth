import type { Command } from 'commander';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { wrap, type RunCtx } from '../lib/runner.js';
import { requireInitialized } from '../lib/gating.js';
import { GrowthError } from '../lib/envelope.js';
import { readEnvValue } from '../lib/env-files.js';

export function registerEnv(program: Command, ctx: RunCtx): void {
  const env = program.command('env').description('Check and update environment keys without printing secrets.');

  env
    .command('check')
    .description('Check whether environment keys are present.')
    .option('--key <key...>', 'Specific key(s) to check.')
    .action(async (opts: { key?: string[] }) => {
      await wrap('growth env check', ctx, async () => {
        await requireInitialized(ctx.getRoot());
        const keys = opts.key?.length
          ? opts.key
          : ['POSTHOG_PERSONAL_API_KEY', 'POSTHOG_PROJECT_ID'];
        return {
          data: {
            keys: Object.fromEntries(
              await Promise.all(keys.map(async (key) => [key, { present: !!(await readEnvValue(ctx.getRoot(), key)) }])),
            ),
          },
          humanText: (
            await Promise.all(keys.map(async (key) => `${key}: ${(await readEnvValue(ctx.getRoot(), key)) ? 'present' : 'missing'}`))
          ).join('\n'),
        };
      });
    });

  env
    .command('set')
    .description('Write or update a key in .env.local without printing the value.')
    .requiredOption('--key <key>', 'Environment key.')
    .option('--value <value>', 'Deprecated unsafe literal value source; use --from-env or --stdin.')
    .option('--from-env <key>', 'Read the value from this process environment variable without echoing it.')
    .option('--stdin', 'Read the value from stdin without echoing it in process args.')
    .option('--file <path>', 'Env file path relative to the repo root.', '.env.local')
    .action(async (opts: { key: string; value?: string; fromEnv?: string; stdin?: boolean; file: string }) => {
      await wrap('growth env set', ctx, async () => {
        await requireInitialized(ctx.getRoot());
        if (!/^[A-Z_][A-Z0-9_]*$/.test(opts.key)) {
          throw new GrowthError('invalid_env_key', 'Environment keys must be uppercase snake case.');
        }
        if (opts.value !== undefined) {
          throw new GrowthError(
            'unsafe_secret_argument',
            'Do not pass secret values via --value because process args and shell history can expose them. Use --from-env or --stdin.',
          );
        }
        if (Number(!!opts.fromEnv) + Number(!!opts.stdin) !== 1) {
          throw new GrowthError('invalid_env_value_source', 'Provide exactly one of --from-env or --stdin.');
        }
        if (opts.fromEnv && !/^[A-Z_][A-Z0-9_]*$/.test(opts.fromEnv)) {
          throw new GrowthError('invalid_env_key', '--from-env must name an uppercase snake case environment variable.');
        }
        const value = opts.stdin ? await readStdinValue() : process.env[opts.fromEnv!];
        if (value === undefined) {
          throw new GrowthError('missing_source_env', `${opts.fromEnv} is not present in the current process environment.`);
        }
        const file = path.resolve(ctx.getRoot(), opts.file);
        const changed = await upsertEnv(file, opts.key, value);
        return {
          data: {
            file: path.relative(ctx.getRoot(), file),
            key: opts.key,
            changed,
            source: opts.fromEnv ? { from_env: opts.fromEnv, present: true } : { stdin: true },
            value: '[redacted]',
          },
          humanText: `${opts.key} ${changed ? 'updated' : 'already set'} in ${path.relative(ctx.getRoot(), file)}.`,
          nextSteps: ['growth env check --json'],
        };
      });
    });
}

async function upsertEnv(file: string, key: string, value: string): Promise<boolean> {
  let current = '';
  try {
    current = await fs.readFile(file, 'utf8');
  } catch {
    // create below
  }
  const lines = current ? current.split('\n') : [];
  const nextLine = `${key}=${JSON.stringify(value)}`;
  let changed = false;
  let found = false;
  const next = lines.map((line) => {
    if (line.startsWith(`${key}=`)) {
      found = true;
      if (line !== nextLine) changed = true;
      return nextLine;
    }
    return line;
  });
  if (!found) {
    next.push(nextLine);
    changed = true;
  }
  await fs.writeFile(file, next.filter((line, i) => line || i < next.length - 1).join('\n') + '\n');
  return changed;
}

async function readStdinValue(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString('utf8').replace(/\r?\n$/, '');
}
