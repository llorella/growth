import type { Dirent } from 'node:fs';
import { promises as fs } from 'node:fs';
import path from 'node:path';

export interface SpaAgentContextScan {
  uses_client_navigation: boolean;
  mentions_synthetic_params: boolean;
  persists_agent_context: boolean;
  files_scanned: number;
}

export async function scanSpaAgentContext(root: string): Promise<SpaAgentContextScan> {
  const files = await listSourceFiles(root);
  let usesClientNavigation = false;
  let mentionsSyntheticParams = false;
  let persistsAgentContext = false;
  for (const file of files) {
    let text = '';
    try {
      text = await fs.readFile(path.join(root, file), 'utf8');
    } catch {
      continue;
    }
    usesClientNavigation ||= /react-router-dom|next\/link|<Link|<NavLink|useNavigate|router\.push|navigate\(/.test(text);
    mentionsSyntheticParams ||= /agent_generated|agent_run_id/.test(text);
    persistsAgentContext ||= /sessionStorage[\s\S]{0,240}(agent_generated|agent_run_id|agent-context)|(agent_generated|agent_run_id|agent-context)[\s\S]{0,240}sessionStorage/.test(text);
  }
  return {
    uses_client_navigation: usesClientNavigation,
    mentions_synthetic_params: mentionsSyntheticParams,
    persists_agent_context: persistsAgentContext,
    files_scanned: files.length,
  };
}

async function listSourceFiles(root: string): Promise<string[]> {
  const out: string[] = [];
  async function walk(rel: string): Promise<void> {
    let entries: Dirent[] = [];
    try {
      entries = await fs.readdir(path.join(root, rel), { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const child = path.join(rel, entry.name);
      if (entry.isDirectory()) {
        if (['node_modules', 'dist', 'build', '.next', '.growth'].includes(entry.name)) continue;
        await walk(child);
      } else if (/\.(tsx?|jsx?)$/.test(entry.name)) {
        out.push(child);
      }
      if (out.length >= 250) return;
    }
  }
  await walk('src');
  await walk('app');
  await walk('pages');
  return Array.from(new Set(out));
}
