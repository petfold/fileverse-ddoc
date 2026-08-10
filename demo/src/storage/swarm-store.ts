import { useEffect, useMemo, useState } from 'react';
import {
  SwarmStorageConfig,
  createSwarmImageFetchFn,
  createSwarmImageUploadFn,
} from '../../../package/utils/swarm-storage';
import { listStamps } from '../../../package/utils/swarm-stamps';

/**
 * Demo wiring for Ethereum Swarm image storage.
 *
 * Opt-in via env: set `VITE_BEE_API_URL` (e.g. http://localhost:1633) to
 * store editor images encrypted on Swarm instead of inlining them.
 * `VITE_SWARM_POSTAGE_BATCH_ID` pins a specific postage batch; without it
 * the first usable batch on the node is auto-discovered.
 */

const beeUrl: string | undefined = import.meta.env.VITE_BEE_API_URL;
const pinnedBatch: string | undefined = import.meta.env
  .VITE_SWARM_POSTAGE_BATCH_ID;

export const useSwarmImageStorage = () => {
  const [config, setConfig] = useState<SwarmStorageConfig | null>(null);

  useEffect(() => {
    if (!beeUrl) return;
    let cancelled = false;
    (async () => {
      try {
        if (pinnedBatch) {
          setConfig({ beeUrl, postageBatchId: pinnedBatch });
          return;
        }
        const usable = (await listStamps({ beeUrl })).find((s) => s.usable);
        if (cancelled) return;
        if (!usable) {
          console.warn(
            `Swarm: no usable postage batch on ${beeUrl} — images stay inline`,
          );
          return;
        }
        console.info(
          `Swarm: storing images via ${beeUrl} (batch ${usable.batchID.slice(0, 8)}…)`,
        );
        setConfig({ beeUrl, postageBatchId: usable.batchID });
      } catch (error) {
        console.warn('Swarm: Bee node not reachable — images stay inline', error);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return useMemo(
    () =>
      config
        ? {
            imageUploadFn: createSwarmImageUploadFn(config),
            imageFetchFn: createSwarmImageFetchFn(config),
          }
        : { imageUploadFn: undefined, imageFetchFn: undefined },
    [config],
  );
};
