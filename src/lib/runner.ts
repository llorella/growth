/**
 * Every command runs through wrap(). It:
 *   - resolves meta (initialized, root)
 *   - calls the handler
 *   - wraps the result in a JSON envelope (or prints human text)
 *   - appends an audit record
 *   - exits 0 on ok, 1 on failure
 */
import { isInitialized } from './state.js';
import { append, type AuditRecord } from './audit.js';
import {
  failure,
  success,
  type Envelope,
  type EnvelopeMeta,
  type EnvelopeNext,
  type EnvelopeWarning,
} from './envelope.js';

export interface HandlerResult<T> {
  data: T;
  humanText?: string;
  nextSteps?: string[];
  next?: EnvelopeNext;
  warnings?: EnvelopeWarning[];
}

export interface RunCtx {
  version: string;
  getRoot: () => string;
  isJson: () => boolean;
  assumeYes: () => boolean;
  noInteractive: () => boolean;
  verbose: () => boolean;
}

async function meta(root: string): Promise<EnvelopeMeta> {
  return { initialized: await isInitialized(root), root };
}

export async function wrap<T>(
  command: string,
  ctx: RunCtx,
  handler: () => Promise<HandlerResult<T>>,
): Promise<void> {
  const start = Date.now();
  const root = ctx.getRoot();
  let envelope: Envelope<T> | Envelope;
  let auditError: string | undefined;

  try {
    const result = await handler();
    envelope = success(command, ctx.version, result.data, await meta(root), {
      nextSteps: result.nextSteps,
      next: result.next,
      warnings: result.warnings,
    });
    output(envelope, ctx.isJson(), result.humanText);
  } catch (err) {
    envelope = failure(command, ctx.version, err, await meta(root));
    auditError = envelope.error?.code;
    output(envelope, ctx.isJson());
  }

  const rec: AuditRecord = {
    ts: new Date().toISOString(),
    command,
    args: redactArgs(process.argv.slice(2)),
    ok: envelope.ok,
    duration_ms: Date.now() - start,
    error_code: auditError,
  };
  await append(root, rec);

  process.exit(envelope.ok ? 0 : 1);
}

function redactArgs(args: string[]): string[] {
  const secretKeys = new Set(['--value', '--api-key', '--token', '--secret', '--password']);
  const out: string[] = [];
  let redactNext = false;
  for (const arg of args) {
    if (redactNext) {
      out.push('[redacted]');
      redactNext = false;
      continue;
    }
    const [key] = arg.split('=', 1);
    if (secretKeys.has(key)) {
      out.push(arg.includes('=') ? `${key}=[redacted]` : arg);
      redactNext = !arg.includes('=');
      continue;
    }
    out.push(arg);
  }
  return out;
}

function output(env: Envelope, isJson: boolean, humanText?: string): void {
  if (isJson) {
    process.stdout.write(JSON.stringify(env, null, 2) + '\n');
    return;
  }
  if (env.ok) {
    if (humanText) process.stdout.write(humanText + '\n');
    else process.stdout.write(JSON.stringify(env.data, null, 2) + '\n');
    if (env.next_steps.length) {
      process.stdout.write('\nNext steps:\n');
      for (const s of env.next_steps) process.stdout.write(`  - ${s}\n`);
    }
    return;
  }
  process.stderr.write(`error [${env.error?.code}] ${env.error?.message}\n`);
  if (env.error?.details) {
    process.stderr.write(JSON.stringify(env.error.details, null, 2) + '\n');
  }
}
