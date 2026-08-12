// @vitest-environment node
import { describe, expect, it } from 'vitest';
import {
  SwarmDiagnosticsInput,
  diagnoseSwarm,
  primarySwarmCondition,
} from './swarm-diagnostics';
import { StampHealth } from './swarm-stamps';

const healthy: SwarmDiagnosticsInput = {
  online: true,
  nodeReachable: true,
  hasBatch: true,
  stamp: {
    batchID: 'ab'.repeat(32),
    usable: true,
    utilization: 0.4,
    ttlSeconds: 30 * 86400,
    expiresAt: new Date(0),
    status: 'ok',
  },
  localFallback: 'browser',
};

const withStamp = (over: Partial<StampHealth>): SwarmDiagnosticsInput => ({
  ...healthy,
  stamp: { ...healthy.stamp!, ...over },
});

describe('diagnoseSwarm', () => {
  it('says nothing when everything is healthy', () => {
    expect(diagnoseSwarm(healthy)).toEqual([]);
    expect(primarySwarmCondition(healthy)).toBeNull();
  });

  it('distinguishes being offline from the node being down', () => {
    const offline = primarySwarmCondition({ ...healthy, online: false });
    const nodeDown = primarySwarmCondition({
      ...healthy,
      nodeReachable: false,
    });
    expect(offline?.kind).toBe('offline');
    expect(nodeDown?.kind).toBe('node-unreachable');
    // Different causes must not offer the same explanation.
    expect(offline?.title).not.toBe(nodeDown?.title);
  });

  it('reports being offline rather than blaming the node', () => {
    const conditions = diagnoseSwarm({
      ...healthy,
      online: false,
      nodeReachable: false,
    });
    expect(conditions.map((c) => c.kind)).toEqual(['offline']);
  });

  it('treats a missing batch as blocking, with a way to fix it', () => {
    const condition = primarySwarmCondition({
      ...healthy,
      hasBatch: false,
      stamp: null,
    });
    expect(condition?.kind).toBe('no-batch');
    expect(condition?.severity).toBe('blocked');
    expect(condition?.remedies.map((r) => r.kind)).toContain('buy-batch');
  });

  it('offers a top-up before expiry and after it', () => {
    const expiring = primarySwarmCondition(
      withStamp({ status: 'expiring', ttlSeconds: 2 * 86400 }),
    );
    expect(expiring?.kind).toBe('batch-expiring');
    expect(expiring?.severity).toBe('warning');
    expect(expiring?.title).toContain('2 days');

    const expired = primarySwarmCondition(
      withStamp({ status: 'unusable', ttlSeconds: 0 }),
    );
    expect(expired?.kind).toBe('batch-expired');
    expect(expired?.severity).toBe('blocked');
    expect(expired?.remedies.map((r) => r.kind)).toContain('top-up-batch');
  });

  it('singularises the last day', () => {
    const condition = primarySwarmCondition(
      withStamp({ status: 'expiring', ttlSeconds: 86400 }),
    );
    expect(condition?.title).toContain('1 day');
    expect(condition?.title).not.toContain('1 days');
  });

  it('explains a filling batch in terms of what runs out', () => {
    const condition = primarySwarmCondition(
      withStamp({ status: 'nearly-full', utilization: 0.94 }),
    );
    expect(condition?.kind).toBe('batch-full');
    expect(condition?.title).toContain('94%');
    expect(condition?.remedies.map((r) => r.kind)).toContain('dilute-batch');
  });

  it('flags every remedy that spends money', () => {
    for (const input of [
      { ...healthy, hasBatch: false, stamp: null },
      withStamp({ status: 'unusable', ttlSeconds: 0 }),
      withStamp({ status: 'nearly-full', utilization: 0.95 }),
    ]) {
      for (const remedy of primarySwarmCondition(input)!.remedies) {
        const costs = ['buy-batch', 'top-up-batch', 'dilute-batch'].includes(
          remedy.kind,
        );
        expect(remedy.spendsFunds ?? false).toBe(costs);
      }
    }
  });

  it('surfaces an unmodelled failure verbatim', () => {
    const condition = primarySwarmCondition({
      ...healthy,
      lastError: 'Swarm request timed out after 60s: /bytes/abc',
    });
    expect(condition?.kind).toBe('operation-failed');
    expect(condition?.detail).toContain('timed out');
  });

  it('does not add a generic failure on top of a known cause', () => {
    const kinds = diagnoseSwarm({
      ...healthy,
      nodeReachable: false,
      lastError: 'connection refused',
    }).map((c) => c.kind);
    expect(kinds).toContain('node-unreachable');
    expect(kinds).not.toContain('operation-failed');
  });

  it('orders blocking conditions ahead of warnings', () => {
    const conditions = diagnoseSwarm({
      ...withStamp({ status: 'nearly-full', utilization: 0.99 }),
      nodeReachable: false,
    });
    expect(conditions[0].severity).toBe('blocked');
    expect(conditions.length).toBeGreaterThan(1);
  });

  it('adjusts the reassurance when there is no local copy', () => {
    const withFallback = primarySwarmCondition({
      ...healthy,
      hasBatch: false,
      stamp: null,
    });
    const without = primarySwarmCondition({
      ...healthy,
      hasBatch: false,
      stamp: null,
      localFallback: 'none',
    });
    expect(withFallback?.detail).toContain('kept in this browser');
    expect(without?.detail).toContain('not being stored anywhere else');
  });
});
