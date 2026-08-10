// @vitest-environment node
import { describe, expect, it } from 'vitest';
import {
  PostageStamp,
  checkStampHealth,
  getStamp,
  listStamps,
  stampUtilization,
} from './swarm-stamps';

const BEE_URL = process.env.BEE_API_URL || 'http://localhost:1633';

const beeAvailable = await (async () => {
  try {
    const res = await fetch(`${BEE_URL}/health`, {
      signal: AbortSignal.timeout(2000),
    });
    return res.ok;
  } catch {
    return false;
  }
})();

const baseStamp: PostageStamp = {
  batchID: 'ab'.repeat(32),
  utilization: 4,
  utilizationRatio: 0.5,
  usable: true,
  label: '',
  depth: 19,
  amount: '1000000',
  bucketDepth: 16,
  blockNumber: 1,
  immutableFlag: true,
  exists: true,
  batchTTL: 30 * 24 * 60 * 60,
};

describe('stampUtilization', () => {
  it('prefers utilizationRatio when Bee provides it', () => {
    expect(stampUtilization(baseStamp)).toBe(0.5);
  });

  it('falls back to bucket math on older Bee', () => {
    const older = { ...baseStamp, utilizationRatio: undefined };
    // 4 of 2^(19-16)=8 buckets used
    expect(stampUtilization(older)).toBe(0.5);
  });
});

// Read-only against a live node; buy/top-up/dilute spend xBZZ and are
// deliberately not exercised here.
describe.skipIf(!beeAvailable)('stamp endpoints (live Bee node)', () => {
  it('lists batches and fetches one by id', async () => {
    const stamps = await listStamps({ beeUrl: BEE_URL });
    expect(Array.isArray(stamps)).toBe(true);
    if (stamps.length === 0) return;

    const stamp = await getStamp({ beeUrl: BEE_URL }, stamps[0].batchID);
    expect(stamp.batchID).toBe(stamps[0].batchID);
    expect(stamp.depth).toBeGreaterThan(0);
  });

  it('reports health with sensible fields', async () => {
    const stamps = await listStamps({ beeUrl: BEE_URL });
    if (stamps.length === 0) return;

    const health = await checkStampHealth(
      { beeUrl: BEE_URL },
      stamps[0].batchID,
    );
    expect(health.batchID).toBe(stamps[0].batchID);
    expect(health.utilization).toBeGreaterThanOrEqual(0);
    expect(health.utilization).toBeLessThanOrEqual(1);
    expect(['ok', 'expiring', 'nearly-full', 'unusable']).toContain(
      health.status,
    );
    expect(health.expiresAt.getTime()).toBeGreaterThan(0);
  });

  it('flags a healthy batch as expiring under a strict threshold', async () => {
    const stamps = await listStamps({ beeUrl: BEE_URL });
    const usable = stamps.find((s) => s.usable && s.batchTTL > 0);
    if (!usable) return;

    const health = await checkStampHealth({ beeUrl: BEE_URL }, usable.batchID, {
      minTtlSeconds: usable.batchTTL + 1000,
    });
    expect(health.status).toBe('expiring');
  });
});
