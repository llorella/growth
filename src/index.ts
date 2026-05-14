#!/usr/bin/env node
import { Command } from 'commander';
import type { RunCtx } from './lib/runner.js';

import { registerInit } from './cli/init.js';
import { registerStatus } from './cli/status.js';
import { registerProject } from './cli/project.js';
import { registerSchema } from './cli/schema.js';
import { registerExperiments } from './cli/experiments.js';
import { registerTemplates } from './cli/templates.js';
import { registerConnectors } from './cli/connectors.js';
import { registerCatalog } from './cli/catalog.js';
import { registerInstrumentation } from './cli/instrumentation.js';
import { registerPreflight } from './cli/preflight.js';
import { registerValidate } from './cli/validate.js';
import { registerEnv } from './cli/env.js';
import { registerPull } from './cli/pull.js';
import { registerPowerCalc } from './cli/power-calc.js';
import { registerLlmContext } from './cli/llm-context.js';
import { registerDoctor } from './cli/doctor.js';

export const VERSION = '0.1.0';

const program = new Command();
program
  .name('growth')
  .description('Agent-native growth experimentation control plane.')
  .version(VERSION)
  .option('--root <dir>', 'Framework root (defaults to cwd)')
  .option('--json', 'JSON envelope output')
  .option('--no-interactive', 'Fail instead of prompting')
  .option('--yes', 'Assume yes for safe confirmations')
  .option('--verbose', 'Include extra diagnostics');

const ctx: RunCtx = {
  version: VERSION,
  getRoot: () => program.opts().root ?? process.cwd(),
  isJson: () => !!program.opts().json,
  assumeYes: () => !!program.opts().yes,
  noInteractive: () => !!program.opts().noInteractive,
  verbose: () => !!program.opts().verbose,
};

registerInit(program, ctx);
registerStatus(program, ctx);
registerProject(program, ctx);
registerSchema(program, ctx);
registerExperiments(program, ctx);
registerTemplates(program, ctx);
registerConnectors(program, ctx);
registerCatalog(program, ctx);
registerInstrumentation(program, ctx);
registerPreflight(program, ctx);
registerValidate(program, ctx);
registerEnv(program, ctx);
registerPull(program, ctx);
registerPowerCalc(program, ctx);
registerLlmContext(program, ctx);
registerDoctor(program, ctx);

program.parseAsync(process.argv).catch((err) => {
  process.stderr.write(`growth: unhandled: ${err?.message ?? err}\n`);
  process.exit(1);
});
