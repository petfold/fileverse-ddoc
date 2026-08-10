// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { generatePrivateKey } from 'viem/accounts';
import {
  createSwarmDocumentStorage,
  generateDocumentKey,
} from './swarm-document-storage';
import { chunkAddress } from './swarm-feeds';

const BEE_URL = process.env.BEE_API_URL || 'http://localhost:1633';

// These tests need a running Bee node (or `bee dev`) with a usable postage
// batch; they are skipped otherwise so the suite stays green without Swarm.
const probeBee = async (): Promise<string | null> => {
  try {
    const health = await fetch(`${BEE_URL}/health`, {
      signal: AbortSignal.timeout(2000),
    });
    if (!health.ok) return null;
    const res = await fetch(`${BEE_URL}/stamps`, {
      signal: AbortSignal.timeout(2000),
    });
    const { stamps } = (await res.json()) as {
      stamps: { batchID: string; usable: boolean }[];
    };
    return stamps.find((s) => s.usable)?.batchID ?? null;
  } catch {
    return null;
  }
};

const postageBatchId = await probeBee();

// Live-network feed lookups (especially for not-yet-existing feeds) resolve
// across the swarm and routinely take tens of seconds.
const LIVE_TIMEOUT = { timeout: 120_000 };
const bytesToHex = (bytes: Uint8Array): string =>
  Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');

describe('chunkAddress', () => {
  it.skipIf(!postageBatchId)(
    'matches the reference Bee computes for /bytes uploads',
    async () => {
      const payload = crypto.getRandomValues(new Uint8Array(1024));
      const res = await fetch(`${BEE_URL}/bytes`, {
        method: 'POST',
        headers: {
          'content-type': 'application/octet-stream',
          'swarm-postage-batch-id': postageBatchId!,
        },
        body: payload,
      });
      const { reference } = (await res.json()) as { reference: string };
      expect(bytesToHex(chunkAddress(payload))).toBe(reference);
    },
  );

  it('rejects payloads larger than one chunk', () => {
    expect(() => chunkAddress(new Uint8Array(4097))).toThrow();
  });
});

describe.skipIf(!postageBatchId)(
  'swarm document storage (live Bee node)',
  () => {
    const makeStorage = (documentKey?: string) =>
      createSwarmDocumentStorage({
        beeUrl: BEE_URL,
        postageBatchId: postageBatchId!,
        ownerPrivateKey: generatePrivateKey(),
        documentKey,
      });

    it(
      'returns null for a document that was never saved',
      LIVE_TIMEOUT,
      async () => {
        const storage = makeStorage(generateDocumentKey());
        expect(await storage.loadDocument('no-such-doc')).toBeNull();
        expect(await storage.listDocumentVersions('no-such-doc')).toEqual([]);
      },
    );

    it(
      'saves, loads and versions an encrypted document',
      LIVE_TIMEOUT,
      async () => {
        const storage = makeStorage(generateDocumentKey());
        const ddocId = `test-${bytesToHex(crypto.getRandomValues(new Uint8Array(8)))}`;

        const v0 = await storage.saveDocument(ddocId, 'version zero');
        const v1 = await storage.saveDocument(ddocId, 'version one');
        const v2 = await storage.saveDocument(ddocId, 'version two — latest');
        expect([v0.index, v1.index, v2.index]).toEqual([0, 1, 2]);

        const latest = await storage.loadDocument(ddocId);
        expect(latest?.text).toBe('version two — latest');
        expect(latest?.feedIndex).toBe(2);
        expect(latest?.reference).toBe(v2.reference);

        const historical = await storage.loadDocumentVersion(ddocId, 1);
        expect(historical?.text).toBe('version one');

        const versions = await storage.listDocumentVersions(ddocId);
        expect(versions.map((v) => v.index)).toEqual([0, 1, 2]);
        expect(versions.map((v) => v.reference)).toEqual([
          v0.reference,
          v1.reference,
          v2.reference,
        ]);
      },
    );

    it(
      'stores only ciphertext when a documentKey is set',
      LIVE_TIMEOUT,
      async () => {
        const storage = makeStorage(generateDocumentKey());
        const ddocId = `test-${bytesToHex(crypto.getRandomValues(new Uint8Array(8)))}`;
        const { reference } = await storage.saveDocument(
          ddocId,
          'MARKER-doc-plaintext-must-not-leak',
        );
        const raw = new Uint8Array(
          await (await fetch(`${BEE_URL}/bytes/${reference}`)).arrayBuffer(),
        );
        expect(new TextDecoder().decode(raw)).not.toContain('MARKER-doc');
      },
    );

    it(
      'cannot decrypt with a different documentKey',
      LIVE_TIMEOUT,
      async () => {
        const ddocId = `test-${bytesToHex(crypto.getRandomValues(new Uint8Array(8)))}`;
        const ownerPrivateKey = generatePrivateKey();
        const write = createSwarmDocumentStorage({
          beeUrl: BEE_URL,
          postageBatchId: postageBatchId!,
          ownerPrivateKey,
          documentKey: generateDocumentKey(),
        });
        await write.saveDocument(ddocId, 'secret');

        const wrongKey = createSwarmDocumentStorage({
          beeUrl: BEE_URL,
          ownerPrivateKey,
          documentKey: generateDocumentKey(),
        });
        await expect(wrongKey.loadDocument(ddocId)).rejects.toThrow();
      },
    );

    it(
      'supports plaintext storage when no documentKey is given',
      LIVE_TIMEOUT,
      async () => {
        const storage = makeStorage(undefined);
        const ddocId = `test-${bytesToHex(crypto.getRandomValues(new Uint8Array(8)))}`;
        await storage.saveDocument(ddocId, 'public content');
        const loaded = await storage.loadDocument(ddocId);
        expect(loaded?.text).toBe('public content');
      },
    );
  },
);
