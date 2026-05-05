#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import path from 'node:path';

interface RpcRequest {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
}

const tools: Array<[string, string[]]> = [
  ['growth_status', ['status']],
  ['growth_llm_context', ['llm-context']],
  ['growth_experiment_create', ['experiment', 'create']],
  ['growth_instrumentation_plan', ['instrumentation', 'plan']],
  ['growth_instrumentation_verify', ['instrumentation', 'verify']],
  ['growth_preflight_prepare', ['preflight', 'prepare']],
  ['growth_preflight_dry_run', ['preflight', 'dry-run']],
  ['growth_preflight_pull', ['preflight', 'pull']],
  ['growth_preflight_audit', ['preflight', 'audit']],
  ['growth_analyze', ['analyze']],
] ;

const byName = new Map(tools);

const rl = createInterface({ input: process.stdin });
rl.on('line', async (line) => {
  if (!line.trim()) return;
  let req: RpcRequest;
  try {
    req = JSON.parse(line) as RpcRequest;
  } catch {
    respond(null, { code: -32700, message: 'Parse error' });
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
        tools: tools.map(([name]) => ({
          name,
          description: `Run ${name.replace(/^growth_/, 'growth ').replaceAll('_', ' ')} and return the growth JSON envelope.`,
          inputSchema: {
            type: 'object',
            properties: {
              root: { type: 'string' },
              args: { type: 'array', items: { type: 'string' } },
            },
            additionalProperties: false,
          },
        })),
      });
      return;
    }
    if (req.method === 'tools/call') {
      const name = String(req.params?.name ?? '');
      const tool = byName.get(name);
      if (!tool) throw new Error(`Unknown tool: ${name}`);
      const input = (req.params?.arguments ?? {}) as { root?: string; args?: string[] };
      const env = await runGrowth(input.root, [...tool, ...(input.args ?? [])]);
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
