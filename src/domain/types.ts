/**
 * Core types for an experiment spec. 1:1 with the JSON Schema in
 * domain/schema.ts - agents read the schema, produce JSON, the framework
 * parses into these types. Keep them in sync.
 */

export type ExperimentStatus = 'draft' | 'running' | 'stopped' | 'completed' | 'archived';
export type MetricType = 'proportion' | 'continuous' | 'count';
export type MetricRole = 'primary' | 'secondary' | 'guardrail';
export type Direction = 'higher_is_better' | 'lower_is_better';

export interface Variant {
  id: string;
  name: string;
  description?: string;
  weight: number;
}

export interface Metric {
  id: string;
  name: string;
  role: MetricRole;
  type: MetricType;
  direction: Direction;
  event: string;
  denominator_event?: string;
  value_field?: string;
  guardrail_threshold?: number;
}

export type TargetingOperator =
  | 'equals'
  | 'not_equals'
  | 'in'
  | 'not_in'
  | 'contains'
  | 'matches';

export interface TargetingRule {
  field: string;
  op: TargetingOperator;
  value: string | number | boolean | (string | number)[];
}

export interface Targeting {
  rules: TargetingRule[];
  segments?: string[];
  domains?: string[];
}

export interface SampleSizeConfig {
  baseline_rate: number;
  minimum_detectable_effect: number;
  power: number;
  alpha: number;
  per_variant?: number;
}

export interface ScheduleConfig {
  start_at?: string;
  max_duration_days: number;
  min_runtime_days?: number;
}

export interface AutoStopConfig {
  on_significance: boolean;
  on_guardrail_breach: boolean;
  min_runtime_days: number;
}

export interface Experiment {
  id: string;
  name: string;
  hypothesis: string;
  owner?: string;
  status: ExperimentStatus;
  variants: Variant[];
  metrics: Metric[];
  targeting: Targeting;
  sample_size: SampleSizeConfig;
  schedule: ScheduleConfig;
  auto_stop?: AutoStopConfig;
  instrumentation?: InstrumentationContract;
  preflight?: PreflightConfig;
  notes?: string;
  created_at: string;
  updated_at: string;
  started_at?: string;
  stopped_at?: string;
  stop_reason?: string;
}

export interface PreflightConfig {
  scenarios?: PreflightScenario[];
}

export interface PreflightScenario {
  id: string;
  goal: string;
  instructions?: string[];
  expected_events?: string[];
}

export interface InstrumentationContract {
  assignment?: {
    stable_by?: string;
    properties?: string[];
  };
  events?: Array<{
    event: string;
    required_properties: string[];
  }>;
}

export interface Assignment {
  experiment_id: string;
  user_id: string;
  anonymous_id?: string;
  variant_id: string;
  assigned_at: string;
  source?: string;
  context?: Record<string, unknown>;
}

export interface ExperimentEvent {
  id?: string;
  experiment_id: string;
  user_id: string;
  anonymous_id?: string;
  variant_id: string;
  event: string;
  timestamp: string;
  source?: string;
  payload?: Record<string, unknown>;
  /** Stable idempotency key used to dedupe overlapping pulls. */
  idempotency_key?: string;
}

export interface AnalysisResult {
  experiment_id: string;
  status: ExperimentStatus;
  runtime_days: number;
  total_users: number;
  per_variant: Record<string, { users: number }>;
  metrics: MetricAnalysis[];
  recommendation: Recommendation;
  generated_at: string;
  segment: AnalysisSegment;
}

export type AnalysisSegment = 'all' | 'real-users' | 'agent-generated';

export interface MetricAnalysis {
  metric_id: string;
  metric_name: string;
  role: MetricRole;
  type: MetricType;
  direction: Direction;
  variants: Record<
    string,
    {
      n: number;
      successes?: number;
      sum?: number;
      rate?: number;
      mean?: number;
    }
  >;
  comparisons: ComparisonResult[];
}

export interface ComparisonResult {
  variant_id: string;
  baseline_id: string;
  absolute_diff: number;
  relative_lift: number;
  p_value: number;
  confidence_interval_95: { lower: number; upper: number };
  significant: boolean;
  status: 'significant' | 'not_significant' | 'insufficient_data';
}

export interface Recommendation {
  action:
    | 'ship_treatment'
    | 'keep_running'
    | 'stop_inconclusive'
    | 'rollback'
    | 'guardrail_breach'
    | 'instrumentation_incomplete'
    | 'synthetic_only_no_ship';
  confidence: 'high' | 'medium' | 'low';
  reasoning: string;
  next_steps: string[];
}

export interface GrowthRun {
  id: string;
  type: 'preflight' | 'instrumentation' | 'pull' | 'analysis';
  experiment_id?: string;
  status: 'prepared' | 'running' | 'completed' | 'failed' | 'canceled';
  created_at: string;
  started_at?: string;
  completed_at?: string;
  event_window?: {
    after: string;
    before?: string;
  };
  agents?: AgentPacketSummary[];
  artifacts: Record<string, string>;
  warnings: Array<{ code: string; message: string }>;
}

export interface AgentPacketSummary {
  agent_id: string;
  browser: boolean;
  variant_id?: string;
  url_file: string;
  prompt_file: string;
  report_schema_file: string;
  policy_file: string;
}
