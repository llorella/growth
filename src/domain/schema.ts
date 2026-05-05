/**
 * JSON Schema for experiment specs. The contract agents read to generate
 * valid experiments. Intentionally strict - agents do better with explicit
 * constraints than permissive schemas.
 */
export const experimentSchema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'https://growth.dev/schema/experiment.json',
  title: 'Experiment',
  description: 'An A/B or multi-variant experiment configuration.',
  type: 'object',
  required: ['id', 'name', 'hypothesis', 'variants', 'metrics', 'sample_size', 'schedule'],
  properties: {
    id: {
      type: 'string',
      pattern: '^[a-z][a-z0-9-]{2,63}$',
      description: 'Lowercase, hyphenated identifier. Used as filename and stable ref.',
    },
    name: { type: 'string', minLength: 3, maxLength: 120 },
    hypothesis: {
      type: 'string',
      minLength: 20,
      description:
        'A complete sentence: "We believe [change] will [effect] because [reasoning]."',
    },
    owner: { type: 'string' },
    status: {
      type: 'string',
      enum: ['draft', 'running', 'stopped', 'completed', 'archived'],
      default: 'draft',
    },
    variants: {
      type: 'array',
      minItems: 2,
      maxItems: 6,
      items: {
        type: 'object',
        required: ['id', 'name', 'weight'],
        properties: {
          id: { type: 'string', pattern: '^[a-z][a-z0-9_]*$' },
          name: { type: 'string' },
          description: { type: 'string' },
          weight: { type: 'number', minimum: 0, maximum: 100 },
        },
        additionalProperties: false,
      },
      description:
        'Convention: first variant is control. Weights should sum to 100 but framework normalizes.',
    },
    metrics: {
      type: 'array',
      minItems: 1,
      items: {
        type: 'object',
        required: ['id', 'name', 'role', 'type', 'direction', 'event'],
        properties: {
          id: { type: 'string', pattern: '^[a-z][a-z0-9_]*$' },
          name: { type: 'string' },
          role: { type: 'string', enum: ['primary', 'secondary', 'guardrail'] },
          type: { type: 'string', enum: ['proportion', 'continuous', 'count'] },
          direction: { type: 'string', enum: ['higher_is_better', 'lower_is_better'] },
          event: {
            type: 'string',
            description: 'Event name that signals the success/measurement.',
          },
          denominator_event: {
            type: 'string',
            description: 'For proportions: the event whose count is the denominator.',
          },
          value_field: {
            type: 'string',
            description: 'For continuous metrics: the payload field to aggregate.',
          },
          guardrail_threshold: {
            type: 'number',
            description:
              'For guardrails: trip if the rate moves more than this (e.g., 0.15 = 15%).',
          },
        },
        additionalProperties: false,
      },
      description: 'Exactly one metric should be role=primary.',
    },
    targeting: {
      type: 'object',
      properties: {
        rules: {
          type: 'array',
          items: {
            type: 'object',
            required: ['field', 'op', 'value'],
            properties: {
              field: {
                type: 'string',
                description:
                  'Dot-path into the user/context object. E.g., "utm_source", "device.platform".',
              },
              op: {
                type: 'string',
                enum: ['equals', 'not_equals', 'in', 'not_in', 'contains', 'matches'],
              },
              value: {},
            },
            additionalProperties: false,
          },
        },
        segments: {
          type: 'array',
          items: { type: 'string' },
          description: 'Documentation-only labels for the targeted segment.',
        },
        domains: {
          type: 'array',
          items: { type: 'string' },
          description: 'Domains this experiment runs on.',
        },
      },
      additionalProperties: false,
    },
    sample_size: {
      type: 'object',
      required: ['baseline_rate', 'minimum_detectable_effect', 'power', 'alpha'],
      properties: {
        baseline_rate: { type: 'number', exclusiveMinimum: 0, exclusiveMaximum: 1 },
        minimum_detectable_effect: { type: 'number', exclusiveMinimum: 0 },
        power: { type: 'number', minimum: 0.5, maximum: 0.99, default: 0.8 },
        alpha: { type: 'number', minimum: 0.01, maximum: 0.2, default: 0.05 },
        per_variant: { type: 'integer', minimum: 1 },
      },
      additionalProperties: false,
    },
    schedule: {
      type: 'object',
      required: ['max_duration_days'],
      properties: {
        start_at: { type: 'string', format: 'date-time' },
        max_duration_days: { type: 'integer', minimum: 1, maximum: 90 },
        min_runtime_days: { type: 'integer', minimum: 1, default: 7 },
      },
      additionalProperties: false,
    },
    auto_stop: {
      type: 'object',
      properties: {
        on_significance: { type: 'boolean', default: true },
        on_guardrail_breach: { type: 'boolean', default: true },
        min_runtime_days: { type: 'integer', minimum: 1, default: 7 },
      },
      additionalProperties: false,
    },
    notes: { type: 'string' },
    instrumentation: {
      type: 'object',
      properties: {
        assignment: {
          type: 'object',
          properties: {
            stable_by: { type: 'string' },
            properties: { type: 'array', items: { type: 'string' } },
          },
          additionalProperties: false,
        },
        events: {
          type: 'array',
          items: {
            type: 'object',
            required: ['event', 'required_properties'],
            properties: {
              event: { type: 'string' },
              required_properties: { type: 'array', items: { type: 'string' } },
            },
            additionalProperties: false,
          },
        },
      },
      additionalProperties: false,
    },
    preflight: {
      type: 'object',
      properties: {
        scenarios: {
          type: 'array',
          minItems: 1,
          items: {
            type: 'object',
            required: ['id', 'goal'],
            properties: {
              id: { type: 'string', pattern: '^[a-z][a-z0-9_\\-]*$' },
              goal: {
                type: 'string',
                description: 'What this synthetic browser packet should try to exercise.',
              },
              instructions: { type: 'array', items: { type: 'string' } },
              expected_events: { type: 'array', items: { type: 'string' } },
            },
            additionalProperties: false,
          },
        },
      },
      additionalProperties: false,
    },
    created_at: { type: 'string', format: 'date-time' },
    updated_at: { type: 'string', format: 'date-time' },
    started_at: { type: 'string', format: 'date-time' },
    stopped_at: { type: 'string', format: 'date-time' },
    stop_reason: { type: 'string' },
  },
  additionalProperties: false,
} as const;

export const connectorSchema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'https://growth.dev/schema/connector.json',
  title: 'Connector',
  type: 'object',
  required: ['source', 'kind', 'event_name_path', 'user_id_path', 'experiment_id_path', 'variant_id_path', 'mappings'],
  properties: {
    source: { type: 'string', pattern: '^[a-z][a-z0-9-]*$' },
    kind: { type: 'string', enum: ['posthog', 'segment', 'stripe', 'native-app', 'warehouse', 'custom'] },
    user_id_path: { type: 'string' },
    anonymous_id_path: { type: 'string' },
    experiment_id_path: { type: 'string' },
    variant_id_path: { type: 'string' },
    event_name_path: { type: 'string' },
    timestamp_path: { type: 'string' },
    idempotency_key_path: { type: 'string' },
    posthog: {
      type: 'object',
      required: ['project_id'],
      properties: {
        host: { type: 'string' },
        project_id: { type: ['string', 'number'] },
        api_key_env: { type: 'string' },
      },
      additionalProperties: false,
    },
    local: {
      type: 'object',
      required: ['events_file'],
      properties: {
        events_file: { type: 'string' },
      },
      additionalProperties: false,
    },
    mappings: {
      type: 'object',
      additionalProperties: {
        type: 'object',
        properties: {
          framework_event: { type: 'string' },
          payload_paths: {
            type: 'object',
            additionalProperties: { type: 'string' },
          },
          payload_static: { type: 'object' },
        },
        additionalProperties: false,
      },
    },
  },
  additionalProperties: false,
} as const;

export const eventTaxonomySchema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'https://growth.dev/schema/event-taxonomy.json',
  title: 'Event taxonomy',
  type: 'object',
  required: ['events'],
  properties: {
    events: {
      type: 'array',
      items: {
        type: 'object',
        required: ['event', 'description'],
        properties: {
          event: { type: 'string' },
          description: { type: 'string' },
          required_properties: { type: 'array', items: { type: 'string' } },
        },
        additionalProperties: false,
      },
    },
  },
  additionalProperties: false,
} as const;

export const preflightReportSchema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'https://growth.dev/schema/preflight-report.json',
  title: 'Preflight agent report',
  type: 'object',
  required: [
    'primary_goal_observed',
    'stopped_at_url',
    'stop_reason',
    'path_taken',
    'confusing_or_broken',
    'blockers',
    'internal_ui_visible',
    'missing_expected_events',
    'screenshot_or_trace_artifacts',
  ],
  properties: {
    primary_goal_observed: { type: 'boolean' },
    stopped_at_url: { type: 'string' },
    stop_reason: { type: 'string', enum: ['completed', 'stuck', 'error', 'skipped'] },
    path_taken: { type: 'array', items: { type: 'string' } },
    email_used: { type: ['string', 'null'] },
    variant_observed: { type: ['string', 'null'] },
    primary_surface_observed: { type: ['string', 'null'] },
    primary_metric_events_observed: { type: 'array', items: { type: 'string' } },
    guardrail_observed: { type: 'boolean' },
    confusing_or_broken: { type: 'array', items: { type: 'string' } },
    blockers: { type: 'array', items: { type: 'string' } },
    internal_ui_visible: { type: 'array', items: { type: 'string' } },
    missing_expected_events: { type: 'array', items: { type: 'string' } },
    screenshot_or_trace_artifacts: { type: 'array', items: { type: 'string' } },
    completed_onboarding: { type: 'boolean' },
    primary_app_observed: { type: ['string', 'null'] },
    conversion_observed: { type: 'boolean' },
    activation_observed: { type: 'boolean' },
    guardrail_issue_observed: { type: 'boolean' },
    auth_or_payment_blockers: { type: 'array', items: { type: 'string' } },
  },
  additionalProperties: false,
} as const;
