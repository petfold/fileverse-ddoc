import { useEffect, useMemo, useState } from 'react';
import { generatePrivateKey } from 'viem/accounts';
import {
  SwarmStorageConfig,
  createSwarmImageFetchFn,
  createSwarmImageUploadFn,
} from '../../../package/utils/swarm-storage';
import {
  StampHealth,
  checkStampHealth,
  listStamps,
} from '../../../package/utils/swarm-stamps';
import {
  SwarmDocumentStorage,
  createSwarmDocumentStorage,
  generateDocumentKey,
} from '../../../package/utils/swarm-document-storage';

/**
 * Demo wiring for Ethereum Swarm storage (images + document content).
 *
 * Opt-in via env: set `VITE_BEE_API_URL` (e.g. http://localhost:1633) to
 * store editor images AND document snapshots encrypted on Swarm.
 * `VITE_SWARM_POSTAGE_BATCH_ID` pins a specific postage batch; without it
 * the first usable batch on the node is auto-discovered.
 *
 * Demo-grade key handling: the feed owner key and per-document encryption
 * keys are generated once and kept in localStorage.
 */

const beeUrl: string | undefined = import.meta.env.VITE_BEE_API_URL;
const pinnedBatch: string | undefined = import.meta.env
  .VITE_SWARM_POSTAGE_BATCH_ID;

/** Whether Swarm storage is configured (sync, before any probing). */
export const swarmEnabled = Boolean(beeUrl);

const persistedKey = (storageKey: string, generate: () => string): string => {
  let value = localStorage.getItem(storageKey);
  if (!value) {
    value = generate();
    localStorage.setItem(storageKey, value);
  }
  return value;
};

export const useSwarmStorage = (docId: string) => {
  const [config, setConfig] = useState<SwarmStorageConfig | null>(null);
  const [stampHealth, setStampHealth] = useState<StampHealth | null>(null);

  useEffect(() => {
    if (!beeUrl) return;
    let cancelled = false;
    (async () => {
      try {
        const batchId =
          pinnedBatch ??
          (await listStamps({ beeUrl })).find((s) => s.usable)?.batchID;
        if (cancelled) return;
        if (!batchId) {
          console.warn(
            `Swarm: no usable postage batch on ${beeUrl} — Swarm storage disabled`,
          );
          return;
        }
        console.info(
          `Swarm: storing images and documents via ${beeUrl} (batch ${batchId.slice(0, 8)}…)`,
        );
        setConfig({ beeUrl, postageBatchId: batchId });
        setStampHealth(await checkStampHealth({ beeUrl }, batchId));
      } catch (error) {
        console.warn('Swarm: Bee node not reachable — Swarm storage disabled', error);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const docStorage: SwarmDocumentStorage | null = useMemo(() => {
    if (!config) return null;
    return createSwarmDocumentStorage({
      ...config,
      ownerPrivateKey: persistedKey('ddoc-swarm-owner-key', () =>
        generatePrivateKey(),
      ) as `0x${string}`,
      documentKey: persistedKey(
        `ddoc-swarm-doc-key-${docId}`,
        generateDocumentKey,
      ),
    });
  }, [config, docId]);

  const imageFns = useMemo(
    () =>
      config
        ? {
            imageUploadFn: createSwarmImageUploadFn(config),
            imageFetchFn: createSwarmImageFetchFn(config),
          }
        : { imageUploadFn: undefined, imageFetchFn: undefined },
    [config],
  );

  return { ...imageFns, docStorage, stampHealth };
};
