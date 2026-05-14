import type { Command } from 'commander';
import { GrowthError } from '../lib/envelope.js';
import { requireInitialized } from '../lib/gating.js';
import {
  normalizeRoutePath,
  patchProjectProfile,
  projectProfileUnknowns,
  readProjectProfile,
  upsertProjectAuthContext,
  upsertProjectRoute,
} from '../lib/project-profile.js';
import { wrap, type RunCtx } from '../lib/runner.js';
import { parseFrameworkOption } from './framework-option.js';

export function registerProject(program: Command, ctx: RunCtx): void {
  const project = program.command('project').description('Show and configure explicit Growth project profile facts.');

  project
    .command('show')
    .description('Show the Growth project profile used by runtime planning commands.')
    .action(async () => {
      await wrap('growth project show', ctx, async () => {
        await requireInitialized(ctx.getRoot());
        const profile = await readProjectProfile(ctx.getRoot());
        const unknowns = projectProfileUnknowns(profile);
        return {
          data: {
            profile,
            unknowns,
            next_command: unknowns[0]?.next_command ?? 'growth status --json',
          },
          humanText: JSON.stringify(profile, null, 2),
          nextSteps: unknowns.length ? unknowns.map((unknown) => unknown.next_command) : ['growth status --json'],
          next: {
            command: unknowns[0]?.next_command ?? 'growth status --json',
            until: unknowns[0]?.reason ?? 'project profile has been reviewed',
          },
        };
      });
    });

  project
    .command('configure')
    .description('Set explicit project facts used by Growth runtime planning.')
    .option('--framework <id>', 'Framework id, for example nextjs-app-router or react-vite.')
    .option('--app-url <url>', 'Default application URL for browser-agent packets.')
    .action(async (opts: { framework?: string; appUrl?: string }) => {
      await wrap('growth project configure', ctx, async () => {
        await requireInitialized(ctx.getRoot());
        if (!opts.framework && !opts.appUrl) {
          throw new GrowthError('nothing_to_configure', 'Pass --framework, --app-url, or both.');
        }
        const profile = await patchProjectProfile(ctx.getRoot(), (current) => ({
          ...current,
          ...(opts.framework
            ? {
                framework: {
                  id: parseFrameworkOption(opts.framework),
                  source: 'user',
                },
              }
            : {}),
          app_urls: {
            ...current.app_urls,
            ...(opts.appUrl ? { default: opts.appUrl } : {}),
          },
        }));
        return {
          data: {
            profile,
            unknowns: projectProfileUnknowns(profile),
          },
          humanText: JSON.stringify(profile, null, 2),
          nextSteps: ['growth project show --json', 'growth status --json'],
          next: {
            command: 'growth project show --json',
            until: 'explicit project facts are confirmed',
          },
        };
      });
    });

  project
    .command('route')
    .description('Manage explicit project routes.')
    .command('add <id>')
    .description('Add or update a named route in the Growth project profile.')
    .requiredOption('--path <path>', 'Browser route path, for example /onboarding.')
    .action(async (id: string, opts: { path: string }) => {
      await wrap('growth project route add', ctx, async () => {
        await requireInitialized(ctx.getRoot());
        const profile = await patchProjectProfile(ctx.getRoot(), (current) =>
          upsertProjectRoute(current, {
            id,
            path: normalizeRoutePath(opts.path),
            source: 'user',
          }),
        );
        return {
          data: {
            profile,
            route: profile.routes.find((route) => route.id === id),
          },
          humanText: JSON.stringify(profile.routes.find((route) => route.id === id), null, 2),
          nextSteps: ['growth project show --json'],
          next: {
            command: 'growth project show --json',
            until: 'route configuration is confirmed',
          },
        };
      });
    });

  project
    .command('auth-context')
    .description('Manage explicit auth contexts.')
    .command('add <id>')
    .description('Add or update a named auth context in the Growth project profile.')
    .option('--requires-session', 'Browser packets need an authenticated session for this context.', false)
    .option('--no-requires-session', 'Browser packets do not need an authenticated session for this context.')
    .action(async (id: string, opts: { requiresSession: boolean }) => {
      await wrap('growth project auth-context add', ctx, async () => {
        await requireInitialized(ctx.getRoot());
        const profile = await patchProjectProfile(ctx.getRoot(), (current) =>
          upsertProjectAuthContext(current, {
            id,
            requires_session: opts.requiresSession,
            source: 'user',
          }),
        );
        return {
          data: {
            profile,
            auth_context: profile.auth_contexts.find((authContext) => authContext.id === id),
          },
          humanText: JSON.stringify(profile.auth_contexts.find((authContext) => authContext.id === id), null, 2),
          nextSteps: ['growth project show --json'],
          next: {
            command: 'growth project show --json',
            until: 'auth context configuration is confirmed',
          },
        };
      });
    });
}
