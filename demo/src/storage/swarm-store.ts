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

/**
 * Key resolution: URL fragment first (so a copied link carries the keys to
 * another browser/private window — the fragment never leaves the browser),
 * then localStorage; generated on first use. The fragment is kept in sync
 * so the address bar URL is always shareable.
 */
const readHashKeys = (): { owner: string; doc: string } | null => {
  const match = window.location.hash.match(/skey=([^:]+):([^&]+)/);
  return match
    ? {
        owner: decodeURIComponent(match[1]),
        doc: decodeURIComponent(match[2]),
      }
    : null;
};

const writeHashKeys = (owner: string, doc: string) => {
  const skey = `skey=${encodeURIComponent(owner)}:${encodeURIComponent(doc)}`;
  if (!window.location.hash.includes(skey)) {
    window.history.replaceState(null, '', `#${skey}`);
  }
};

const resolveKeys = (
  docId: string,
  generateOwner: () => string,
  generateDoc: () => string,
): { owner: string; doc: string } => {
  const ownerStorageKey = 'ddoc-swarm-owner-key';
  const docStorageKey = `ddoc-swarm-doc-key-${docId}`;
  const fromHash = readHashKeys();
  const owner =
    fromHash?.owner ?? localStorage.getItem(ownerStorageKey) ?? generateOwner();
  const doc =
    fromHash?.doc ?? localStorage.getItem(docStorageKey) ?? generateDoc();
  localStorage.setItem(ownerStorageKey, owner);
  localStorage.setItem(docStorageKey, doc);
  writeHashKeys(owner, doc);
  return { owner, doc };
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
    const keys = resolveKeys(docId, generatePrivateKey, generateDocumentKey);
    return createSwarmDocumentStorage({
      ...config,
      ownerPrivateKey: keys.owner as `0x${string}`,
      documentKey: keys.doc,
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
