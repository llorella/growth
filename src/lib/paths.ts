/**
 * Canonical path layout for a growth-managed repo. All other modules
 * import from here so renames are one-place changes.
 */
import path from 'node:path';

export function paths(root: string) {
  const dot = path.join(root, '.growth');
  return {
    root,
    dot,
    stateFile: path.join(dot, 'state.json'),
    stateLocalFile: path.join(dot, 'state.local.json'),
    auditFile: path.join(dot, 'audit.jsonl'),
    dataDir: path.join(dot, 'data'),
    assignmentsFile: path.join(dot, 'data', 'assignments.jsonl'),
    eventsFile: path.join(dot, 'data', 'events.jsonl'),
    pullCursorsFile: path.join(dot, 'data', 'pull-cursors.json'),
    dotGitignore: path.join(dot, '.gitignore'),
    experimentsDir: path.join(dot, 'experiments'),
    templatesDir: path.join(dot, 'templates'),
    connectorsDir: path.join(dot, 'connectors'),
    eventTaxonomyFile: path.join(dot, 'event-taxonomy.json'),
    runsDir: path.join(dot, 'runs'),
    cursorRulesDir: path.join(root, '.cursor', 'rules'),
    cursorRuleFile: path.join(root, '.cursor', 'rules', 'growth.mdc'),
    agentsSkillWorkflowsDir: path.join(root, '.agents', 'skills', 'growth', 'workflows'),
    claudeSkillDir: path.join(root, '.claude', 'skills', 'growth'),
    agentsSkillDir: path.join(root, '.agents', 'skills', 'growth'),
    agentsFile: path.join(root, 'AGENTS.md'),
    claudeFile: path.join(root, 'CLAUDE.md'),
    rootGitignore: path.join(root, '.gitignore'),
  };
}

export type Paths = ReturnType<typeof paths>;
