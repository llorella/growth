/**
 * JSON envelope for every CLI response. Modeled on Stripe Projects'
 * jsonOutput.ts - agents parse the envelope, not raw payloads.
 */

export interface EnvelopeError {
  code: string;
  message: string;
  details?: Record<string, unknown>;
}

export interface EnvelopeWarning {
  code: string;
  message: string;
}

export interface EnvelopeMeta {
  initialized: boolean;
  root: string;
}

export interface EnvelopeNext {
  command: string;
  until: string;
}

export interface Envelope<T = unknown> {
  ok: boolean;
  command: string;
  version: string;
  data?: T;
  error?: EnvelopeError;
  warnings: EnvelopeWarning[];
  next_steps: string[];
  _next?: EnvelopeNext;
  meta: EnvelopeMeta;
}

export class GrowthError extends Error {
  constructor(
    public code: string,
    message: string,
    public details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'GrowthError';
  }
}

export function success<T>(
  command: string,
  version: string,
  data: T,
  meta: EnvelopeMeta,
  options: { warnings?: EnvelopeWarning[]; nextSteps?: string[]; next?: EnvelopeNext } = {},
): Envelope<T> {
  return {
    ok: true,
    command,
    version,
    data,
    warnings: options.warnings ?? [],
    next_steps: options.nextSteps ?? [],
    ...(options.next ? { _next: options.next } : {}),
    meta,
  };
}

export function failure(
  command: string,
  version: string,
  err: unknown,
  meta: EnvelopeMeta,
  options: { warnings?: EnvelopeWarning[]; nextSteps?: string[] } = {},
): Envelope {
  const error: EnvelopeError =
    err instanceof GrowthError
      ? { code: err.code, message: err.message, details: err.details }
      : err instanceof Error
        ? { code: 'internal_error', message: err.message }
        : { code: 'internal_error', message: String(err) };
  return {
    ok: false,
    command,
    version,
    error,
    warnings: options.warnings ?? [],
    next_steps: options.nextSteps ?? [],
    meta,
  };
}
