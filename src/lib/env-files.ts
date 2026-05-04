import { promises as fs } from 'node:fs';
import path from 'node:path';

const LOCAL_ENV_FILES = ['.env', '.env.local', '.env.development', '.env.development.local'];

export async function readEnvValue(root: string, key: string): Promise<string | undefined> {
  return process.env[key] ?? (await readLocalEnv(root))[key];
}

export async function readLocalEnv(root: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const file of LOCAL_ENV_FILES) {
    try {
      Object.assign(out, parseEnvText(await fs.readFile(path.join(root, file), 'utf8')));
    } catch {
      // File is optional.
    }
  }
  return out;
}

export function parseEnvText(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const normalized = line.startsWith('export ') ? line.slice('export '.length).trim() : line;
    const equals = normalized.indexOf('=');
    if (equals <= 0) continue;
    const key = normalized.slice(0, equals).trim();
    if (!/^[A-Z_][A-Z0-9_]*$/.test(key)) continue;
    out[key] = unquoteEnvValue(normalized.slice(equals + 1).trim());
  }
  return out;
}

function unquoteEnvValue(value: string): string {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  return value;
}
