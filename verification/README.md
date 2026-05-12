# Verification Harness

`verification/` is the active harness for testing Growth against real target
repositories. It replaces `outerloop/` for new work.

The harness keeps target repositories disposable:

- create a clean temporary git worktree
- copy explicitly configured env files into that worktree
- expose the current Growth CLI through `PATH`
- write a short agent prompt
- optionally launch an agent in the worktree
- collect the target repo diff, Growth state, run packets, and traces
- remove the worktree unless `--keep` is set

Run directories are ignored under `verification/runs/`.

Target configs may set `envFiles`, for example `[".env"]`. These files are
copied from the target repo into the disposable worktree before the agent starts
so local app servers can use the same runtime config. Artifact collection
excludes `.env` and `.env.*` files from status, untracked lists, and patches.

## Aptny

Prepare a clean Aptny verification worktree and prompt:

```sh
npm run verify:aptny
```

Launch with an agent command:

```sh
npm run verify:aptny -- --agent-command "codex exec --json --dangerously-bypass-approvals-and-sandbox --skip-git-repo-check --cd {{WORKTREE}} -"
```

Keep the worktree after the run:

```sh
npm run verify:aptny -- --keep
```

After a run, inspect:

- `artifacts/git-status.txt`
- `artifacts/git-diff.patch`
- `artifacts/growth/`
- `traces/agent.stdout.log`
- `traces/agent.stderr.log`

The harness does not grade the run. The reviewer decides whether the agent used
Growth well, whether the target repo diff is sound, and whether the Growth
artifacts support the conclusion.
