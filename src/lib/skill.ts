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

- Do not read \`.growth/state.local.json\`.
- Do not read \`.env*\`.
- Do not hand-edit \`.growth/state.json\`, \`.growth/audit.jsonl\`, or \`.growth/data/*\`.
- Use \`growth schema experiment --json\` before creating experiment configs.
- Use \`growth instrumentation plan <id> --json\` before editing app code.
- Use \`growth instrumentation verify <id> --json\` after editing app code.
- Prefer the growth MCP server when available; otherwise use \`growth ... --json\`.
- Use \`growth preflight prepare\`, not ad hoc browser-agent prompts.
- Use \`growth pull\` and \`growth analyze\`; do not rely on raw analytics screenshots.
- Never treat agent-generated traffic as real-user evidence.
`;

const SCHEMA_MD = `# growth Schemas

Use \`growth schema experiment --json\`, \`growth schema connector --json\`, \`growth schema event-taxonomy --json\`, and \`growth schema preflight-report --json\`.
`;

const NEXTJS_APP_ROUTER_REFERENCE = `# Next.js App Router Reference

This is a reference shape, not a required file layout. Prefer the host app's existing conventions.

## Assignment

- Read preflight URL params: \`agent_generated\`, \`agent_run_id\`, \`experiment_id\`, and \`variant\`.
- If \`variant\` is present, use it for that synthetic packet. Otherwise assign by a stable hash of the configured stable id.
- Persist assignment in localStorage or server state with \`experiment_id\`, \`variant_id\`, \`user_id\`, optional \`anonymous_id\`, and \`agent_run_id\`.
- Only reset synthetic per-event dedupe when \`agent_run_id\` changes. Do not clear dedupe just because \`agent_generated=true\` is still in the URL.
- Emit each required event once per user/session milestone unless the event is intentionally repeatable.

## Local Connector Event Envelope

The built-in local connector expects PostHog-style JSONL rows:

\`\`\`json
{
  "event": "onboarding_started",
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

Append one JSON object per line to the connector's \`local.events_file\`, commonly \`tmp/events.jsonl\`.

## Verification

After implementing, run:

\`\`\`bash
growth instrumentation verify <experiment_id> --events-file tmp/events.jsonl --json
growth connector validate local --json
\`\`\`
`;

const WORKFLOWS: Record<string, string> = {
  'create-experiment.md': `# Create Experiment

1. Run \`growth status --json\`.
2. Run \`growth schema experiment --json\`.
3. Run \`growth catalog templates --json\`.
4. Create with \`growth experiment create <id> --template <template> --json\`.
5. Confirm with \`growth experiment show <id> --json\`.
`,
  'instrument-app.md': `# Instrument App

1. Run \`growth instrumentation plan <id> --json\`.
2. Read \`connector_event_shapes\`, \`preflight_query_params\`, and \`reference_implementation\` in the plan output.
3. Edit application code to satisfy the assignment, connector envelope, and event contract.
4. Run \`growth instrumentation verify <id> --json\`.
5. If using the local connector, run \`growth instrumentation verify <id> --events-file tmp/events.jsonl --json\`.
`,
  'run-preflight.md': `# Run Preflight

1. Run \`growth preflight prepare <id> --agents 4 --browser --json\`.
2. Note \`event_window.after\`; events before that timestamp are intentionally excluded from \`growth preflight pull\`.
3. Launch each generated packet with the available browser runner.
4. Attach reports with \`growth preflight attach-report <run_id> --agent <n> --file <report.json> --json\`.
5. Complete with \`growth preflight complete <run_id> --json\`.
6. Pull and audit with \`growth preflight pull <run_id> --source <source> --json\` and \`growth preflight audit <run_id> --json\`.
`,
  'pull-and-analyze.md': `# Pull And Analyze

1. Run \`growth connector auth check posthog --json\`.
2. Run \`growth pull <id> --source posthog --after <iso> --json\`.
3. Run \`growth analyze <id> --segment real-users --json\`.
4. For synthetic traffic, run \`growth analyze <id> --segment agent-generated --json\`.
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
