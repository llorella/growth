import { promises as fs } from 'node:fs';
import path from 'node:path';
import { paths } from './paths.js';

const SKILL_MD = `---
name: growth
description: Use the growth CLI to design, instrument, verify, run, pull, and analyze growth experiments in this repository.
allowed-tools:
  - Bash(growth *)
  - Bash(node dist/index.js *)
  - Read(.growth/experiments/*)
  - Read(.growth/connectors/*)
  - Read(.growth/event-taxonomy.json)
---

# growth

Start with:

\`\`\`bash
growth status --json
growth llm-context --json
\`\`\`

Rules:

- If \`growth status --json\` reports \`initialized=false\`, run \`growth init --json\` before creating experiments.
- Do not read \`.growth/state.local.json\`.
- Do not read \`.env*\`.
- Do not hand-edit \`.growth/state.json\`, \`.growth/audit.jsonl\`, or \`.growth/data/*\`.
- Use \`growth schema experiment --json\` before creating experiment configs.
- Use \`growth experiment implementation set <id> --variant <variant_id> ... --json\` when a variant has a concrete branch, worktree, PR, commit, or app URL.
- Use \`growth instrumentation plan <id> --json\` before editing app code.
- Use \`growth instrumentation verify <id> --json\` after editing app code.
- Use \`growth preflight plan <id> --json\` after instrumentation verification.
- Prefer \`growth preflight run <id> --json\` when Growth returns it; it will stop on blockers before preparing packets.
- Follow \`preflight plan.browser_context\`; if it requires an authenticated session, use one and report login/paywall blockers explicitly.
- Do not choose evidence source, connector, app URL, or readiness semantics yourself unless Growth asks.
- Resolve provider-pull blockers only through Growth commands; do not read env files or call analytics provider APIs directly.
- Prefer the growth MCP server when available; otherwise use \`growth ... --json\`.
- Use the next command Growth returns; do not jump directly to local JSONL unless the plan selects it.
- Use \`growth pull\` and \`growth analyze\`; do not rely on raw analytics screenshots.
- Treat \`static_ready\` as static readiness only.
- Treat \`local_synthetic_ready\` as local synthetic readiness only.
- Treat \`ready_for_provider_preflight\` as local synthetic readiness only.
- Treat \`provider_preflight_passed\` as provider-backed synthetic readiness only.
- Never treat agent-generated traffic as real-user evidence.
`;

const SCHEMA_MD = `# growth Schemas

Use \`growth schema experiment --json\`, \`growth schema connector --json\`, \`growth schema event-taxonomy --json\`, and \`growth schema preflight-report --json\`.
`;

const NEXTJS_APP_ROUTER_REFERENCE = `# Next.js App Router Reference

This is a reference shape, not a required file layout. Prefer the host app's existing conventions.

## Assignment

- Read preflight URL params: \`agent_generated\`, \`agent_run_id\`, \`experiment_id\`, and \`variant\`.
- In client-rendered routes, persist those params to sessionStorage before \`Link\` or router navigation removes the query string.
- If \`variant\` is present, use it for that synthetic packet. Otherwise assign by a stable hash of the configured stable id.
- Persist assignment in localStorage or server state with \`experiment_id\`, \`variant_id\`, \`user_id\`, optional \`anonymous_id\`, and \`agent_run_id\`.
- Only reset synthetic per-event dedupe when \`agent_run_id\` changes. Do not clear dedupe just because \`agent_generated=true\` is still in the URL.
- Emit each required event once per user/session milestone unless the event is intentionally repeatable.

## Event Envelope

Growth will choose the evidence source in \`growth preflight plan <id> --json\`.
For PostHog apps, use the app's existing PostHog conventions. If Growth
selects a local JSONL fast loop, the built-in local connector expects
PostHog-style JSONL rows:

\`\`\`json
{
  "event": "experiment_viewed",
  "properties": {
    "event_id": "evt_unique_id",
    "experiment_id": "my-experiment",
    "variant_id": "control",
    "user_id": "user_123",
    "anonymous_id": "anon_123",
    "session_id": "session_123",
    "timestamp": "2026-05-01T00:00:00.000Z",
    "agent_generated": false,
    "agent_run_id": null
  }
}
\`\`\`

Append one JSON object per line only when the preflight plan or connector config
selects local JSONL.

## Verification

After implementing, run:

\`\`\`bash
growth instrumentation verify <experiment_id> --json
growth preflight plan <experiment_id> --json
\`\`\`
`;

const SPA_NAVIGATION_REFERENCE = `# SPA Navigation Reference

This applies to React Router, Vite SPAs, Remix client navigation, and any app where links update routes without a full page load.

## Synthetic Agent Context

Preflight packet URLs include \`agent_generated\`, \`agent_run_id\`, \`experiment_id\`, and \`variant\`.

Client-side navigation often drops those query params. Read them once on first page load, persist them to \`sessionStorage\`, and attach the persisted values to every event.

Canonical emitted event fields:

- \`experiment_id\`
- \`variant_id\`
- \`user_id\`
- \`session_id\`
- \`timestamp\`
- \`agent_generated\`
- \`agent_run_id\`

The query param is named \`variant\` because it forces the synthetic packet branch. The event property should be \`variant_id\`; emit \`variant\` only as a compatibility alias when a connector requires it.

## Verification Loop

After implementing, run:

\`\`\`bash
growth instrumentation verify <experiment_id> --json
growth preflight plan <experiment_id> --json
\`\`\`

Use local JSONL only when \`growth preflight plan\` selects it or explicitly names
it as a fallback.
`;

const WORKFLOWS: Record<string, string> = {
  'create-experiment.md': `# Create Experiment

1. Run \`growth status --json\`.
2. Run \`growth schema experiment --json\`.
3. Inspect the product and user goal before choosing metrics or variants.
4. Author a spec from the schema, or use a template only when the user explicitly chooses one.
5. Create with \`growth experiment create <id> --from-file <spec.json> --json\`.
6. Confirm with \`growth experiment show <id> --json\`.
`,
  'instrument-app.md': `# Instrument App

1. Run \`growth instrumentation plan <id> --json\`.
2. Read \`connector_event_shapes\`, \`preflight_query_params\`, and candidate hints in the plan output.
3. Edit application code to satisfy the assignment, connector envelope, and event contract.
4. Inspect existing app structure yourself; framework hints and candidate files are advisory.
5. If client-side navigation is present, persist preflight query params to sessionStorage before navigation.
6. Run \`growth instrumentation verify <id> --json\`.
7. Run \`growth preflight plan <id> --json\`.
8. Follow the next command returned by Growth; use \`growth preflight run <id> --json\` when offered and do not choose provider vs local evidence yourself.
`,
  'run-preflight.md': `# Run Preflight

1. Run \`growth preflight plan <id> --json\`.
2. Follow the returned \`_next.command\`.
3. If \`browser_context.requires_authenticated_session=true\`, use an authenticated browser session for packet execution and report login/paywall blockers explicitly.
4. If Growth prepares packets, note \`event_window.after\`; events before that timestamp are intentionally excluded from \`growth preflight pull\`.
5. Launch each generated packet with the available browser runner.
6. Attach reports with \`growth preflight attach-report <run_id> --agent <n> --file <report.json> --json\`.
7. Complete with \`growth preflight complete <run_id> --json\`.
8. Pull and audit using the source selected by Growth.
`,
  'pull-and-analyze.md': `# Pull And Analyze

1. Run \`growth connector auth check posthog --json\`.
2. If provider pull is blocked, run the returned \`growth connector auth setup posthog --json\` command and follow only Growth's safe setup commands.
3. Run \`growth pull <id> --source posthog --after <iso> --json\`.
4. Run \`growth analyze <id> --segment real-users --json\`.
5. For synthetic traffic, run \`growth analyze <id> --segment agent-generated --json\`.
`,
  'cleanup-experiment.md': `# Cleanup Experiment

1. Confirm the final state with \`growth experiment show <id> --json\`.
2. Archive abandoned or completed experiments with \`growth experiment archive <id> --json\`.
3. Remove app instrumentation only after confirming no active experiment or analysis depends on those events.
4. Keep \`.growth/runs/*\` and \`.growth/audit.jsonl\` as rollout history unless the user explicitly asks to delete local artifacts.
`,
};

const AGENTS_SECTION = `## growth

This repository is initialized for growth experiments.

Use the \`growth\` CLI as the control plane for experiments, connectors, synthetic preflights, pulls, analysis, and audit.

Start with \`growth status --json\`.
Use \`growth llm-context --json\` for current instructions.
Do not inspect managed state or env files directly.
`;

const CURSOR_RULE = `Use the growth CLI for experiment state and analytics workflows.

Start with \`growth status --json\` and \`growth llm-context --json\`.
Do not read \`.env*\` or \`.growth/state.local.json\`.
Do not hand-edit \`.growth/state.json\`, \`.growth/audit.jsonl\`, or \`.growth/data/*\`.
`;

export async function writeSkill(root: string): Promise<{ wrote: string[] }> {
  const p = paths(root);
  const wrote: string[] = [];

  await fs.mkdir(p.agentsSkillWorkflowsDir, { recursive: true });
  await fs.mkdir(path.join(p.agentsSkillDir, 'references'), { recursive: true });
  await fs.writeFile(path.join(p.agentsSkillDir, 'SKILL.md'), SKILL_MD);
  await fs.writeFile(path.join(p.agentsSkillDir, 'schema.md'), SCHEMA_MD);
  await fs.writeFile(
    path.join(p.agentsSkillDir, 'references', 'nextjs-app-router.md'),
    NEXTJS_APP_ROUTER_REFERENCE,
  );
  await fs.writeFile(
    path.join(p.agentsSkillDir, 'references', 'spa-navigation.md'),
    SPA_NAVIGATION_REFERENCE,
  );
  wrote.push(
    path.join(p.agentsSkillDir, 'SKILL.md'),
    path.join(p.agentsSkillDir, 'schema.md'),
    path.join(p.agentsSkillDir, 'references', 'nextjs-app-router.md'),
    path.join(p.agentsSkillDir, 'references', 'spa-navigation.md'),
  );
  for (const [file, contents] of Object.entries(WORKFLOWS)) {
    const target = path.join(p.agentsSkillWorkflowsDir, file);
    await fs.writeFile(target, contents);
    wrote.push(target);
  }

  await fs.mkdir(path.dirname(p.claudeSkillDir), { recursive: true });
  try {
    await fs.rm(p.claudeSkillDir, { recursive: true, force: true });
    await fs.symlink(path.relative(path.dirname(p.claudeSkillDir), p.agentsSkillDir), p.claudeSkillDir, 'dir');
    wrote.push(p.claudeSkillDir);
  } catch {
    await fs.mkdir(p.claudeSkillDir, { recursive: true });
    await fs.writeFile(path.join(p.claudeSkillDir, 'SKILL.md'), SKILL_MD);
    wrote.push(path.join(p.claudeSkillDir, 'SKILL.md'));
  }

  await fs.mkdir(p.cursorRulesDir, { recursive: true });
  await fs.writeFile(p.cursorRuleFile, CURSOR_RULE);
  wrote.push(p.cursorRuleFile);

  await upsertManagedSection(p.agentsFile, 'growth', AGENTS_SECTION);
  wrote.push(p.agentsFile);
  await upsertManagedSection(
    p.claudeFile,
    'growth',
    'See AGENTS.md for growth experiment instructions. Start with `growth status --json`.\n',
  );
  wrote.push(p.claudeFile);

  return { wrote };
}

async function upsertManagedSection(file: string, name: string, body: string): Promise<void> {
  const start = `<!-- BEGIN ${name} managed section -->`;
  const end = `<!-- END ${name} managed section -->`;
  const section = `${start}\n${body.trimEnd()}\n${end}\n`;
  let current = '';
  try {
    current = await fs.readFile(file, 'utf8');
  } catch {
    // create below
  }
  const pattern = new RegExp(`${escapeRegExp(start)}[\\s\\S]*?${escapeRegExp(end)}\\n?`);
  const next = pattern.test(current)
    ? current.replace(pattern, section)
    : `${current}${current && !current.endsWith('\n') ? '\n' : ''}${section}`;
  await fs.writeFile(file, next);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
