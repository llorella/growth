#!/usr/bin/env node
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const opts = parseArgs(process.argv.slice(2));

if (opts.help || !opts.runDir) {
  process.stdout.write(usage());
  process.exit(opts.help ? 0 : 1);
}

const runDir = path.resolve(repoRoot, opts.runDir);
const audit = await analyzeRun(runDir);
const artifactsDir = path.join(runDir, 'artifacts');
await mkdir(artifactsDir, { recursive: true });
await writeFile(path.join(artifactsDir, 'growth-usage-audit.json'), JSON.stringify(audit, null, 2) + '\n');
process.stdout.write(JSON.stringify(audit, null, 2) + '\n');

async function analyzeRun(dir) {
  const traceFile = path.join(dir, 'traces', 'agent.stdout.log');
  const trace = await readFile(traceFile, 'utf8').catch(() => '');
  const items = parseTrace(trace);
  const commands = items
    .map((item) => item?.item)
    .filter((item) => item?.type === 'command_execution' && typeof item.command === 'string')
    .map((item) => ({
      command: item.command,
      exit_code: item.exit_code ?? null,
      status: item.status ?? null,
      output: typeof item.aggregated_output === 'string' ? item.aggregated_output : '',
    }));
  const growthCommands = commands.filter((command) => isGrowthInvocation(command.command));
  const growthCommandText = growthCommands.map((command) => command.command).join('\n');
  const antiPatterns = detectAntiPatterns(commands);
  const antiPatternCounts = countBy(antiPatterns.map((item) => item.id));
  const preflight = analyzePreflight(commands);
  const required = {
    growth_status_or_init: /\bgrowth (status|init)\b/.test(growthCommandText),
    growth_llm_context: /\bgrowth llm-context\b/.test(growthCommandText),
    instrumentation_plan: /\bgrowth instrumentation plan\b/.test(growthCommandText),
    instrumentation_verify: /\bgrowth instrumentation verify\b/.test(growthCommandText),
    preflight_planned: preflight.planned,
    connector_auth_setup_or_check: /\bgrowth connector auth (setup|check)\b/.test(growthCommandText),
  };
  const missingRequired = Object.entries(required)
    .filter(([, present]) => !present)
    .map(([id]) => id);
  const preflightGaps =
    preflight.planned && !preflight.run_attempted && !preflight.completed_or_blocked_with_reason
      ? ['preflight_planned_but_not_run_or_blocked']
      : [];
  const score = Math.max(
    0,
    100 -
      antiPatterns.reduce((sum, item) => sum + item.penalty, 0) -
      missingRequired.length * 8 -
      preflightGaps.length * 10,
  );
  return {
    score,
    grade: grade(score, antiPatterns, preflightGaps),
    growth_command_count: growthCommands.length,
    command_count: commands.length,
    required,
    missing_required: missingRequired,
    preflight,
    preflight_gaps: preflightGaps,
    anti_pattern_counts: antiPatternCounts,
    anti_patterns: antiPatterns,
    growth_commands: growthCommands.map((command) => command.command),
    summary: summarize(score, antiPatterns, antiPatternCounts, missingRequired, preflightGaps),
  };
}

function parseTrace(text) {
  const out = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      out.push({ type: 'raw', text: line });
    }
  }
  return out;
}

function detectAntiPatterns(commands) {
  const out = [];
  for (const command of commands) {
    const text = command.command;
    if (/\bdotenv\b|\.env(\.local|\b)|cat\s+\.env|sed\b.*\.env/.test(text) && !/\bgrowth env\b/.test(text)) {
      out.push({
        id: 'raw_env_read',
        penalty: 25,
        command: text,
        reason: 'Runner read env files or loaded dotenv outside Growth.',
      });
    }
    if (
      /api\/projects|posthog\.com|posthog\.i\.com|app\.posthog\.com/.test(text) &&
      /\b(fetch|curl|node -e|python)\b/.test(text) &&
      !/\bgrowth\b/.test(text)
    ) {
      out.push({
        id: 'direct_provider_api_probe',
        penalty: 25,
        command: text,
        reason: 'Runner probed provider APIs directly instead of using Growth connector/auth commands.',
      });
    }
    if (/\.growth\/(state\.local\.json|audit\.jsonl|data\/)/.test(text) && !/\bgrowth\b/.test(text)) {
      out.push({
        id: 'managed_growth_state_read',
        penalty: 20,
        command: text,
        reason: 'Runner inspected managed Growth state directly.',
      });
    }
  }
  return out;
}

function analyzePreflight(commands) {
  const growthCommandText = commands
    .filter((command) => isGrowthInvocation(command.command))
    .map((command) => command.command)
    .join('\n');
  const preflightOutputs = commands
    .filter((command) => /\bgrowth preflight (plan|run)\b/.test(command.command))
    .map((command) => command.output)
    .join('\n');
  const providerSetupOutputs = commands
    .filter((command) => /\bgrowth connector auth setup\b/.test(command.command))
    .map((command) => command.output)
    .join('\n');
  const blockedWithReason = /"status"\s*:\s*"blocked"|"current"\s*:\s*"blocked"|manual_input_required|PREFLIGHT_BLOCKED|blocked evidence setup/.test(
    `${preflightOutputs}\n${providerSetupOutputs}`,
  );
  const completed = /\bgrowth preflight (complete|complete-local|pull|audit)\b/.test(growthCommandText);
  return {
    planned: /\bgrowth preflight (plan|run)\b/.test(growthCommandText),
    run_attempted: /\bgrowth preflight run\b/.test(growthCommandText),
    completed,
    blocked_with_reason: blockedWithReason,
    completed_or_blocked_with_reason: completed || blockedWithReason,
  };
}

function isGrowthInvocation(text) {
  return /(?:^|[\s'"(;&|])growth\s+/.test(text);
}

function countBy(values) {
  return values.reduce((counts, value) => {
    counts[value] = (counts[value] ?? 0) + 1;
    return counts;
  }, {});
}

function grade(score, antiPatterns, preflightGaps) {
  if (antiPatterns.length === 0 && preflightGaps.length === 0 && score >= 90) return 'excellent';
  if (score >= 80) return 'good';
  if (score >= 60) return 'needs_improvement';
  return 'poor';
}

function summarize(score, antiPatterns, antiPatternCounts, missingRequired, preflightGaps) {
  if (antiPatterns.length === 0 && missingRequired.length === 0 && preflightGaps.length === 0) {
    return `Growth usage score ${score}: runner stayed inside the Growth control plane.`;
  }
  const parts = [`Growth usage score ${score}.`];
  if (antiPatterns.length) {
    const counts = Object.entries(antiPatternCounts)
      .map(([id, count]) => `${id}=${count}`)
      .join(', ');
    parts.push(`${antiPatterns.length} control-plane anti-pattern(s) detected: ${counts}.`);
  }
  if (missingRequired.length) parts.push(`Missing expected Growth command categories: ${missingRequired.join(', ')}.`);
  if (preflightGaps.length) parts.push(`Preflight did not reach a run attempt, completion, or explicit blocker: ${preflightGaps.join(', ')}.`);
  return parts.join(' ');
}

function usage() {
  return `Usage: node verification/scripts/analyze-run.mjs --run-dir <verification-run-dir>\n`;
}

function parseArgs(args) {
  const out = {};
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--help' || arg === '-h') out.help = true;
    else if (arg.startsWith('--')) out[toCamel(arg.slice(2))] = args[++i];
    else throw new Error(`Unexpected argument: ${arg}`);
  }
  return out;
}

function toCamel(value) {
  return value.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
}
