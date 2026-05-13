#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import path from 'node:path';

interface RpcRequest {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: unknown;
}

interface JsonSchema {
  type: 'object';
  properties: Record<string, unknown>;
  required?: string[];
  additionalProperties: false;
}

interface GrowthTool {
  name: string;
  command: string[];
  description: string;
  inputSchema: JsonSchema;
  toArgs(input: Record<string, unknown>): string[];
}

const rootProperty = {
  root: { type: 'string', description: 'Repository root. Defaults to the MCP server current working directory.' },
};

const tools: GrowthTool[] = [
  tool('growth_status', ['status'], 'Inspect growth project state.', schema({}), () => []),
  tool('growth_llm_context', ['llm-context'], 'Return agent-facing growth project context.', schema({}), () => []),
  tool(
    'growth_experiment_create',
    ['experiment', 'create'],
    'Create an experiment from a template, JSON string, or JSON file.',
    schema(
      {
        experiment_id: { type: 'string' },
        template: { type: 'string' },
        from_file: { type: 'string' },
        from_json: { type: 'string' },
      },
      ['experiment_id'],
    ),
    (input) => [
      requireString(input, 'experiment_id'),
      ...optionalFlag(input, 'template', '--template'),
      ...optionalFlag(input, 'from_file', '--from-file'),
      ...optionalFlag(input, 'from_json', '--from-json'),
    ],
  ),
  tool(
    'growth_experiment_implementation_set',
    ['experiment', 'implementation', 'set'],
    'Record concrete code artifact metadata for one experiment variant.',
    schema(
      {
        experiment_id: { type: 'string' },
        variant: { type: 'string' },
        status: { type: 'string' },
        branch: { type: 'string' },
        worktree: { type: 'string' },
        commit: { type: 'string' },
        pr_url: { type: 'string' },
        app_url: { type: 'string' },
      },
      ['experiment_id', 'variant'],
    ),
    (input) => [
      requireString(input, 'experiment_id'),
      '--variant',
      requireString(input, 'variant'),
      ...optionalFlag(input, 'status', '--status'),
      ...optionalFlag(input, 'branch', '--branch'),
      ...optionalFlag(input, 'worktree', '--worktree'),
      ...optionalFlag(input, 'commit', '--commit'),
      ...optionalFlag(input, 'pr_url', '--pr-url'),
      ...optionalFlag(input, 'app_url', '--app-url'),
    ],
  ),
  tool(
    'growth_instrumentation_plan',
    ['instrumentation', 'plan'],
    'Generate the instrumentation contract for an experiment.',
    schema({ experiment_id: { type: 'string' } }, ['experiment_id']),
    (input) => [requireString(input, 'experiment_id')],
  ),
  tool(
    'growth_instrumentation_verify',
    ['instrumentation', 'verify'],
    'Verify connector coverage and optional emitted app events for an experiment.',
    schema(
      {
        experiment_id: { type: 'string' },
        endpoint: { type: 'string' },
        events_file: { type: 'string' },
      },
      ['experiment_id'],
    ),
    (input) => [
      requireString(input, 'experiment_id'),
      ...optionalFlag(input, 'endpoint', '--endpoint'),
      ...optionalFlag(input, 'events_file', '--events-file'),
    ],
  ),
  tool(
    'growth_preflight_plan',
    ['preflight', 'plan'],
    'Resolve evidence source, target route, readiness ceiling, and next preflight command.',
    schema(
      {
        experiment_id: { type: 'string' },
        app_url: { type: 'string' },
        base_url: { type: 'string' },
      },
      ['experiment_id'],
    ),
    (input) => [
      requireString(input, 'experiment_id'),
      ...optionalFlag(input, 'app_url', '--app-url'),
      ...optionalFlag(input, 'base_url', '--base-url'),
    ],
  ),
  tool(
    'growth_preflight_run',
    ['preflight', 'run'],
    'Plan preflight evidence and prepare browser-agent packets only when unblocked.',
    schema(
      {
        experiment_id: { type: 'string' },
        agents: { type: 'integer', minimum: 1, maximum: 50 },
        browser: { type: 'boolean' },
        app_url: { type: 'string' },
        base_url: { type: 'string' },
        force_variant: { type: 'string' },
        balance_variants: { type: 'boolean' },
      },
      ['experiment_id'],
    ),
    (input) => [
      requireString(input, 'experiment_id'),
      ...optionalNumberFlag(input, 'agents', '--agents'),
      ...booleanFlag(input, 'browser', '--browser'),
      ...optionalFlag(input, 'app_url', '--app-url'),
      ...optionalFlag(input, 'base_url', '--base-url'),
      ...optionalFlag(input, 'force_variant', '--force-variant'),
      ...(optionalBoolean(input, 'balance_variants') === false ? ['--no-balance-variants'] : []),
    ],
  ),
  tool(
    'growth_preflight_prepare',
    ['preflight', 'prepare'],
    'Prepare browser-agent preflight packets for an experiment.',
    schema(
      {
        experiment_id: { type: 'string' },
        agents: { type: 'integer', minimum: 1, maximum: 50 },
        browser: { type: 'boolean' },
        app_url: { type: 'string' },
        base_url: { type: 'string' },
        force_variant: { type: 'string' },
        balance_variants: { type: 'boolean' },
      },
      ['experiment_id'],
    ),
    (input) => [
      requireString(input, 'experiment_id'),
      ...optionalNumberFlag(input, 'agents', '--agents'),
      ...booleanFlag(input, 'browser', '--browser'),
      ...optionalFlag(input, 'app_url', '--app-url'),
      ...optionalFlag(input, 'base_url', '--base-url'),
      ...optionalFlag(input, 'force_variant', '--force-variant'),
      ...(optionalBoolean(input, 'balance_variants') === false ? ['--no-balance-variants'] : []),
    ],
  ),
  tool(
    'growth_preflight_dry_run',
    ['preflight', 'dry-run'],
    'Audit local synthetic JSONL before provider-backed preflight.',
    schema(
      {
        experiment_id: { type: 'string' },
        events_file: { type: 'string' },
        reports_dir: { type: 'string' },
      },
      ['experiment_id', 'events_file'],
    ),
    (input) => [
      requireString(input, 'experiment_id'),
      '--events-file',
      requireString(input, 'events_file'),
      ...optionalFlag(input, 'reports_dir', '--reports-dir'),
    ],
  ),
  tool(
    'growth_preflight_pull',
    ['preflight', 'pull'],
    'Pull provider or local events for a prepared preflight run.',
    schema(
      {
        run_id: { type: 'string' },
        source: { type: 'string' },
        before: { type: 'string' },
        limit: { type: 'integer', minimum: 1 },
      },
      ['run_id', 'source'],
    ),
    (input) => [
      requireString(input, 'run_id'),
      '--source',
      requireString(input, 'source'),
      ...optionalFlag(input, 'before', '--before'),
      ...optionalNumberFlag(input, 'limit', '--limit'),
    ],
  ),
  tool(
    'growth_preflight_audit',
    ['preflight', 'audit'],
    'Audit a completed preflight run.',
    schema(
      {
        run_id: { type: 'string' },
        markdown: { type: 'boolean' },
      },
      ['run_id'],
    ),
    (input) => [requireString(input, 'run_id'), ...booleanFlag(input, 'markdown', '--markdown')],
  ),
  tool(
    'growth_analyze',
    ['analyze'],
    'Analyze real-user or synthetic experiment results.',
    schema(
      {
        experiment_id: { type: 'string' },
        segment: { type: 'string', enum: ['real-users', 'agent-generated', 'all'] },
      },
      ['experiment_id'],
    ),
    (input) => [requireString(input, 'experiment_id'), ...optionalFlag(input, 'segment', '--segment')],
  ),
];

const byName = new Map(tools.map((toolDef) => [toolDef.name, toolDef]));

const rl = createInterface({ input: process.stdin });
rl.on('line', async (line) => {
  if (!line.trim()) return;
  let req: RpcRequest;
  try {
    req = JSON.parse(line) as RpcRequest;
  } catch {
    respond(null, undefined, { code: -32700, message: 'Parse error' });
    return;
  }
  try {
    if (req.method === 'initialize') {
      respond(req.id, {
        protocolVersion: '2024-11-05',
        serverInfo: { name: 'growth', version: '0.1.0' },
        capabilities: { tools: {} },
      });
      return;
    }
    if (req.method === 'tools/list') {
      respond(req.id, {
        tools: tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
      });
      return;
    }
    if (req.method === 'tools/call') {
      const params = isRecord(req.params) ? req.params : {};
      const name = requireString(params, 'name');
      const toolDef = byName.get(name);
      if (!toolDef) throw new Error(`Unknown tool: ${name}`);
      const input = isRecord(params.arguments) ? params.arguments : {};
      const env = await runGrowth(optionalString(input, 'root'), [...toolDef.command, ...toolDef.toArgs(input)]);
      respond(req.id, {
        content: [{ type: 'text', text: JSON.stringify(env, null, 2) }],
        isError: env.ok === false,
      });
      return;
    }
    respond(req.id, { ok: true });
  } catch (err) {
    respond(req.id, undefined, {
      code: -32000,
      message: err instanceof Error ? err.message : String(err),
    });
  }
});

function respond(id: RpcRequest['id'], result?: unknown, error?: { code: number; message: string }): void {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, ...(error ? { error } : { result }) }) + '\n');
}

async function runGrowth(root: string | undefined, args: string[]): Promise<Record<string, unknown>> {
  const cli = path.join(path.dirname(new URL(import.meta.url).pathname), 'index.js');
  const finalArgs = [cli, ...(root ? ['--root', root] : []), ...args, '--json'];
  return new Promise((resolve) => {
    const child = spawn(process.execPath, finalArgs, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => (stdout += String(chunk)));
    child.stderr.on('data', (chunk) => (stderr += String(chunk)));
    child.on('close', () => {
      try {
        resolve(JSON.parse(stdout) as Record<string, unknown>);
      } catch {
        resolve({ ok: false, error: { code: 'mcp_cli_error', message: stderr || stdout || 'growth command failed' } });
      }
    });
  });
}

function tool(
  name: string,
  command: string[],
  description: string,
  inputSchema: JsonSchema,
  toArgs: GrowthTool['toArgs'],
): GrowthTool {
  return { name, command, description, inputSchema, toArgs };
}

function schema(properties: Record<string, unknown>, required: string[] = []): JsonSchema {
  return {
    type: 'object',
    properties: { ...rootProperty, ...properties },
    ...(required.length ? { required } : {}),
    additionalProperties: false,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function requireString(input: Record<string, unknown>, key: string): string {
  const value = input[key];
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`Missing required string argument: ${key}`);
  }
  return value;
}

function optionalString(input: Record<string, unknown>, key: string): string | undefined {
  const value = input[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'string') throw new Error(`Expected string argument: ${key}`);
  return value;
}

function optionalBoolean(input: Record<string, unknown>, key: string): boolean | undefined {
  const value = input[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'boolean') throw new Error(`Expected boolean argument: ${key}`);
  return value;
}

function optionalNumber(input: Record<string, unknown>, key: string): number | undefined {
  const value = input[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isInteger(value)) throw new Error(`Expected integer argument: ${key}`);
  return value;
}

function optionalFlag(input: Record<string, unknown>, key: string, flag: string): string[] {
  const value = optionalString(input, key);
  return value === undefined ? [] : [flag, value];
}

function optionalNumberFlag(input: Record<string, unknown>, key: string, flag: string): string[] {
  const value = optionalNumber(input, key);
  return value === undefined ? [] : [flag, String(value)];
}

function booleanFlag(input: Record<string, unknown>, key: string, flag: string): string[] {
  return optionalBoolean(input, key) === true ? [flag] : [];
}
