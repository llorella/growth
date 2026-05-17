import { promises as fs } from 'node:fs';
import path from 'node:path';
import { paths } from './paths.js';

const SKILL_MD = `---
name: growth
description: Use the growth CLI to design, instrument, verify, and run growth experiments in this repository.
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
- Use \`growth pull\`; do not rely on raw analytics screenshots.
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
Use the \`connector_event_shapes\` returned by \`growth instrumentation plan <id> --json\`;
do not assume a provider envelope or local JSONL shape from this reference.
Append local JSONL only when the preflight plan or connector config selects it,
and shape those rows from the selected connector config.

## Authentication for Preflight

When \`browser_context.requires_authenticated_session=true\`, the preflight agent must authenticate before exercising the experiment surface. Common dev-auth patterns:

- **Dev-only auto-signin endpoint**: Many Next.js apps expose a route like \`/api/dev-login?user=test@example.com\` in development that sets a session cookie without interactive auth.
- **Magic link from stdout**: If the app emails a magic link, the dev server often logs the link to stdout. Capture it from the terminal output and navigate directly.
- **Test credential seeding**: Check \`prisma/seed.ts\`, \`scripts/seed.*\`, or the README for pre-seeded test users and passwords.
- **Auth bypass env var**: Some apps skip auth when an env var like \`SKIP_AUTH=true\` or \`NEXT_PUBLIC_MOCK_AUTH=true\` is set in \`.env.local\`.

Report any login, paywall, or onboarding gate that blocks the experiment surface as a blocker in the preflight report.

## Verification

After implementing, run:

\`\`\`bash
growth instrumentation verify <experiment_id> --json
growth preflight plan <experiment_id> --json
\`\`\`
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
};

const AGENTS_SECTION = `## growth

This repository is initialized for growth experiments.

Use the \`growth\` CLI as the control plane for experiments, connectors, synthetic preflights, pulls, and audit.

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
  wrote.push(
    path.join(p.agentsSkillDir, 'SKILL.md'),
    path.join(p.agentsSkillDir, 'schema.md'),
    path.join(p.agentsSkillDir, 'references', 'nextjs-app-router.md'),
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
