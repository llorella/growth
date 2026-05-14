import type { Experiment } from '../core/experiment/types.js';

export const BUILT_IN_TEMPLATES: Record<string, Partial<Experiment>> = {
  'conversion-test': {
    name: 'Conversion test',
    hypothesis:
      'We believe improving the primary call to action will increase conversion because users will see a clearer next step.',
    variants: [
      { id: 'control', name: 'Control', weight: 50 },
      { id: 'treatment', name: 'Treatment', weight: 50 },
    ],
    metrics: [
      {
        id: 'conversion_rate',
        name: 'Conversion rate',
        role: 'primary',
        type: 'proportion',
        direction: 'higher_is_better',
        event: 'conversion_completed',
        denominator_event: 'experiment_viewed',
      },
    ],
    sample_size: {
      baseline_rate: 0.2,
      minimum_detectable_effect: 0.15,
      power: 0.8,
      alpha: 0.05,
    },
    schedule: { max_duration_days: 30, min_runtime_days: 7 },
  },
  'onboarding-activation': {
    name: 'Onboarding activation preflight',
    hypothesis:
      'We believe reducing onboarding friction will increase activation because users can reach product value without getting blocked.',
    variants: [
      { id: 'control', name: 'Control', weight: 50 },
      { id: 'treatment', name: 'Treatment', weight: 50 },
    ],
    metrics: [
      {
        id: 'activation_rate',
        name: 'Activation rate',
        role: 'primary',
        type: 'proportion',
        direction: 'higher_is_better',
        event: 'activation_completed',
        denominator_event: 'onboarding_started',
      },
      {
        id: 'onboarding_completion_rate',
        name: 'Onboarding completion rate',
        role: 'secondary',
        type: 'proportion',
        direction: 'higher_is_better',
        event: 'onboarding_completed',
        denominator_event: 'onboarding_started',
      },
      {
        id: 'onboarding_error_rate',
        name: 'Onboarding error rate',
        role: 'guardrail',
        type: 'proportion',
        direction: 'lower_is_better',
        event: 'onboarding_error',
        denominator_event: 'onboarding_started',
        guardrail_threshold: 0.1,
      },
      {
        id: 'auth_block_rate',
        name: 'Auth block rate',
        role: 'guardrail',
        type: 'proportion',
        direction: 'lower_is_better',
        event: 'auth_blocked',
        denominator_event: 'onboarding_started',
        guardrail_threshold: 0.05,
      },
      {
        id: 'internal_ui_leak_rate',
        name: 'Internal UI leak rate',
        role: 'guardrail',
        type: 'proportion',
        direction: 'lower_is_better',
        event: 'internal_ui_visible',
        denominator_event: 'onboarding_started',
        guardrail_threshold: 0.01,
      },
      {
        id: 'support_or_help_click_rate',
        name: 'Support or help click rate',
        role: 'guardrail',
        type: 'proportion',
        direction: 'lower_is_better',
        event: 'support_or_help_clicked',
        denominator_event: 'onboarding_started',
        guardrail_threshold: 0.2,
      },
    ],
    instrumentation: {
      assignment: {
        stable_by: 'user_id',
        properties: ['experiment_id', 'variant_id', 'user_id', 'session_id'],
      },
      events: [
        'experiment_viewed',
        'onboarding_started',
        'onboarding_step_viewed',
        'onboarding_step_completed',
        'onboarding_completed',
        'activation_completed',
        'onboarding_error',
        'auth_blocked',
        'internal_ui_visible',
        'support_or_help_clicked',
      ].map((event) => ({
        event,
        required_properties: [
          'experiment_id',
          'variant_id',
          'user_id',
          'session_id',
          'timestamp',
          'agent_generated',
          'agent_run_id',
        ],
      })),
    },
    sample_size: {
      baseline_rate: 0.25,
      minimum_detectable_effect: 0.15,
      power: 0.8,
      alpha: 0.05,
    },
    schedule: { max_duration_days: 30, min_runtime_days: 7 },
  },
};

export const DEFAULT_EVENT_TAXONOMY = {
  events: [
    {
      event: 'experiment_viewed',
      description: 'A user viewed a surface controlled by an experiment.',
      required_properties: ['experiment_id', 'variant_id', 'user_id', 'session_id', 'timestamp', 'agent_generated', 'agent_run_id'],
    },
    {
      event: 'conversion_completed',
      description: 'A user completed the primary conversion.',
      required_properties: ['experiment_id', 'variant_id', 'user_id', 'session_id', 'timestamp', 'agent_generated', 'agent_run_id'],
    },
    {
      event: 'onboarding_started',
      description: 'A user started onboarding.',
      required_properties: ['experiment_id', 'variant_id', 'user_id', 'session_id', 'timestamp', 'agent_generated', 'agent_run_id'],
    },
    {
      event: 'onboarding_step_viewed',
      description: 'A user viewed one step in onboarding.',
      required_properties: ['experiment_id', 'variant_id', 'user_id', 'session_id', 'timestamp', 'agent_generated', 'agent_run_id'],
    },
    {
      event: 'onboarding_step_completed',
      description: 'A user completed one step in onboarding.',
      required_properties: ['experiment_id', 'variant_id', 'user_id', 'session_id', 'timestamp', 'agent_generated', 'agent_run_id'],
    },
    {
      event: 'onboarding_completed',
      description: 'A user completed onboarding.',
      required_properties: ['experiment_id', 'variant_id', 'user_id', 'session_id', 'timestamp', 'agent_generated', 'agent_run_id'],
    },
    {
      event: 'activation_completed',
      description: 'A user reached the activation milestone.',
      required_properties: ['experiment_id', 'variant_id', 'user_id', 'session_id', 'timestamp', 'agent_generated', 'agent_run_id'],
    },
    {
      event: 'onboarding_error',
      description: 'A user encountered an onboarding error or blocking failure.',
      required_properties: ['experiment_id', 'variant_id', 'user_id', 'session_id', 'timestamp', 'agent_generated', 'agent_run_id'],
    },
    {
      event: 'auth_blocked',
      description: 'A user was blocked by authentication during onboarding.',
      required_properties: ['experiment_id', 'variant_id', 'user_id', 'session_id', 'timestamp', 'agent_generated', 'agent_run_id'],
    },
    {
      event: 'internal_ui_visible',
      description: 'Internal-only UI was visible to a synthetic user.',
      required_properties: ['experiment_id', 'variant_id', 'user_id', 'session_id', 'timestamp', 'agent_generated', 'agent_run_id'],
    },
    {
      event: 'support_or_help_clicked',
      description: 'A user clicked support, help, or contact during onboarding.',
      required_properties: ['experiment_id', 'variant_id', 'user_id', 'session_id', 'timestamp', 'agent_generated', 'agent_run_id'],
    },
  ],
};

export const CATALOG = {
  connectors: ['local', 'posthog'],
  templates: Object.keys(BUILT_IN_TEMPLATES),
  metric_archetypes: [
    'conversion_rate',
    'activation_rate',
    'retention_proxy',
    'revenue_per_visitor',
    'time_to_value',
    'support_burden',
    'escape_hatch_rate',
  ],
  workflows: ['create-experiment', 'instrument-app', 'prepare-preflight'],
};
