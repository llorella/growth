/**
 * Append every CLI invocation to .growth/audit.jsonl.
 * Best-effort: if the dir doesn't exist (pre-init) we skip silently -
 * we don't want audit failures to mask real command errors.
 */
import { promises as fs } from 'node:fs';
import { paths } from './paths.js';

export interface AuditRecord {
  ts: string;
  command: string;
  args: string[];
  ok: boolean;
  duration_ms: number;
  error_code?: string;
}

export async function append(root: string, rec: AuditRecord): Promise<void> {
  const p = paths(root);
  try {
    await fs.access(p.dot);
    await fs.appendFile(p.auditFile, JSON.stringify(rec) + '\n');
  } catch {
    // swallow - audit must never fail the command
  }
}
