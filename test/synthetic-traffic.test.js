import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildSyntheticTrafficUrl,
  classifyTraffic,
  hasSyntheticTrafficLabels,
  isInSyntheticAgentScope,
  isRealUserEvent,
  isSyntheticEvent,
  syntheticAgentRunId,
  syntheticSimulationRunId,
  syntheticTrafficPayload,
} from '../dist/domain/synthetic-traffic.js';

test('synthetic traffic URL carries stable preflight identity params', () => {
  const url = new URL(
    buildSyntheticTrafficUrl(
      'http://localhost:3000/path?existing=1',
      'activation-test',
      'preflight_1_agent_2',
      'treatment',
    ),
  );

  assert.equal(url.searchParams.get('existing'), '1');
  assert.equal(url.searchParams.get('agent_generated'), 'true');
  assert.equal(url.searchParams.get('agent_run_id'), 'preflight_1_agent_2');
  assert.equal(url.searchParams.get('experiment_id'), 'activation-test');
  assert.equal(url.searchParams.get('variant'), 'treatment');
});

test('synthetic traffic classification is based on agent_generated', () => {
  const synthetic = { payload: syntheticTrafficPayload('agent-1') };
  const real = { payload: { agent_generated: false, agent_run_id: null } };
  const unlabeled = {};

  assert.equal(classifyTraffic(synthetic), 'synthetic');
  assert.equal(isSyntheticEvent(synthetic), true);
  assert.equal(isRealUserEvent(synthetic), false);
  assert.equal(classifyTraffic(real), 'real-user');
  assert.equal(isRealUserEvent(unlabeled), true);
});

test('synthetic traffic labels require a non-empty agent run id', () => {
  assert.equal(hasSyntheticTrafficLabels({ payload: syntheticTrafficPayload('agent-1') }), true);
  assert.equal(syntheticAgentRunId({ payload: syntheticTrafficPayload('agent-1') }), 'agent-1');
  assert.equal(hasSyntheticTrafficLabels({ payload: { agent_generated: true, agent_run_id: '' } }), false);
  assert.equal(hasSyntheticTrafficLabels({ payload: { agent_generated: false, agent_run_id: 'agent-1' } }), false);
});

test('synthetic agent scope keeps unlabeled events visible for audit failures', () => {
  const agentIds = new Set(['agent-1']);

  assert.equal(isInSyntheticAgentScope({ payload: syntheticTrafficPayload('agent-1') }, agentIds), true);
  assert.equal(isInSyntheticAgentScope({ payload: syntheticTrafficPayload('agent-2') }, agentIds), false);
  assert.equal(isInSyntheticAgentScope({ payload: { agent_generated: true } }, agentIds), true);
});

test('simulation run ids share the synthetic traffic convention', () => {
  assert.equal(syntheticSimulationRunId('seed'), 'simulate_seed');
});
