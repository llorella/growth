import { Store } from '../../lib/store.js';
import { listConnectors } from '../../lib/connectors.js';
import { connectorAdapterFor } from '../../connectors/registry.js';
import type { ExperimentEvent, GrowthRun } from '../experiment/types.js';
import {
  allLocalEvidenceWindow,
  filterByEventWindow,
  type EventWindowRejection,
} from '../evidence/event-window.js';
import { isInSyntheticAgentScope } from '../evidence/synthetic-traffic.js';
import { buildPreflightAudit } from './audit-policy.js';
import { readLatestInstrumentationVerification, readReports } from './reports.js';
import type { AuditPreflightOptions, PreflightAudit } from './types.js';

interface FilteredPreflightRunEvents {
  events: ExperimentEvent[];
  rejected: EventWindowRejection<ExperimentEvent>[];
}

export async function auditPreflight(root: string, run: GrowthRun, opts: AuditPreflightOptions = {}): Promise<PreflightAudit> {
  const store = new Store(root);
  const exp = run.experiment_id ? await store.getExperiment(run.experiment_id) : null;
  const reports = opts.reportsOverride ?? (await readReports(root, run));
  const loadedEvents = opts.eventsOverride ?? (run.experiment_id ? await store.readEvents(run.experiment_id) : []);
  const filteredEvents = filterEventsForPreflightRun(loadedEvents, run);
  const latestLocalVerification = run.experiment_id ? await readLatestInstrumentationVerification(root, run.experiment_id) : null;
  return buildPreflightAudit({
    run,
    experiment: exp,
    reports,
    events: filteredEvents.events,
    eventWindowRejections: filteredEvents.rejected,
    latestLocalVerification,
    dryRun: !!opts.dryRun,
    providerBacked: opts.providerBacked ?? (await hasProviderBackedPull(root, run)),
  });
}

function filterEventsForPreflightRun(
  events: ExperimentEvent[],
  run: GrowthRun,
): FilteredPreflightRunEvents {
  const window = run.event_window?.after ? run.event_window : allLocalEvidenceWindow();
  const windowed = filterByEventWindow(events, window);
  const agentIds = new Set((run.agents ?? []).map((agent) => agent.agent_id).filter((id): id is string => !!id));
  const scopedEvents = windowed.inside.filter((event) => isInSyntheticAgentScope(event, agentIds));
  return { events: scopedEvents, rejected: windowed.rejected };
}

async function hasProviderBackedPull(root: string, run: GrowthRun): Promise<boolean> {
  const providerSources = new Set(
    (await listConnectors(root))
      .filter((connector) => connectorAdapterFor(connector)?.providerBacked === true)
      .map((connector) => connector.source),
  );
  return Object.keys(run.artifacts ?? {}).some((key) => {
    if (!key.startsWith('pull_')) return false;
    return providerSources.has(key.slice('pull_'.length));
  });
}
