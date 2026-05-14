import type { Experiment, ExperimentEvent } from '../core/experiment/types.js';
import type { ConnectorConfig } from '../lib/connectors.js';

export type ConnectorEvidenceSource = 'posthog' | 'local_jsonl';
export type ConnectorCapabilityName = 'telemetry_write' | 'provider_pull' | 'local_synthetic';

export interface ConnectorCapability {
  ready: boolean;
  missing: string[];
  required_env?: string[];
}

export interface ConnectorCapabilityStatus {
  source: string;
  kind: ConnectorConfig['kind'];
  provider_backed: boolean;
  capabilities: Partial<Record<ConnectorCapabilityName, ConnectorCapability>>;
  setup_command?: string;
}

export interface ConnectorPullWindow {
  after: string;
  before: string;
}

export interface ConnectorCommandNext {
  command: string;
  until: string;
}

export interface ConnectorAuthCommandResult {
  data: unknown;
  humanText: string;
  nextSteps: string[];
  next?: ConnectorCommandNext;
}

export interface ConnectorDefaultConfigInput {
  source: string;
  projectId?: string | number;
  host?: string;
  apiKeyEnv?: string;
  eventsFile?: string;
  consoleApiKeyEnv?: string;
  mappings?: ConnectorConfig['mappings'];
}

export interface ConnectorImportContext {
  provider: string;
  existing?: ConnectorConfig;
}

export interface ConnectorImportResult {
  source: string;
  connector: ConnectorConfig;
  imported_from: string;
}

export interface ConnectorMapResult {
  event?: ExperimentEvent;
  drop_reason?: string;
}

export interface ConnectorValidationIssue {
  source: string;
  message: string;
  path?: string;
}

export interface ConnectorAdapter {
  kind: ConnectorConfig['kind'];
  defaultSource: string;
  sourceAliases: string[];
  importProviders: string[];
  evidenceSource: ConnectorEvidenceSource;
  providerBacked: boolean;

  defaultConfig(input: ConnectorDefaultConfigInput): ConnectorConfig;
  importConnector?(root: string, context: ConnectorImportContext): Promise<ConnectorImportResult>;
  requiredEnv(connector: ConnectorConfig): string[];
  requiredScopes(connector: ConnectorConfig): string[];
  authEnv(connector: ConnectorConfig): string | undefined;
  mappedEvents(connector: ConnectorConfig): string[];
  validateConfig(connector: ConnectorConfig): ConnectorValidationIssue[];
  capabilityStatus(root: string, connector: ConnectorConfig): Promise<ConnectorCapabilityStatus>;
  coverage(connector: ConnectorConfig, experiment: Experiment): boolean;
  authCheck(root: string, connector: ConnectorConfig): Promise<ConnectorAuthCommandResult>;
  authSetup(root: string, connector: ConnectorConfig): Promise<ConnectorAuthCommandResult>;
  mapEvent(connector: ConnectorConfig, raw: unknown): ConnectorMapResult;
  pullEvents(
    root: string,
    connector: ConnectorConfig,
    window: ConnectorPullWindow,
    limit: number,
  ): Promise<unknown[]>;

  providerPullBlockReason(connector: ConnectorConfig, status: ConnectorCapabilityStatus): string;
  providerPullBlockedWhy(status: ConnectorCapabilityStatus): string;
  coverageBlockedWhy(connector: ConnectorConfig): string;
  readyWhy(): string;
}
