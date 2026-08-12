import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
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
import {
  SwarmProgress,
  swarmFetch,
} from '../../../package/utils/swarm-common';

/**
 * Demo wiring for Ethereum Swarm storage (images + document content).
 *
 * Opt-in via env: set `VITE_BEE_API_URL` (e.g. http://localhost:1633) to
 * store editor images AND document snapshots encrypted on Swarm.
 * `VITE_SWARM_POSTAGE_BATCH_ID` pins a postage batch; without it the first
 * usable batch on the node is auto-discovered.
 *
 * Reading Swarm costs nothing — only uploads are stamped — so a node with
 * no usable batch still opens documents, in read-only mode.
 *
 * Demo-grade key handling: the feed owner key and per-document encryption
 * keys resolve from the URL fragment (shareable link), else localStorage.
 */

const beeUrl: string | undefined = import.meta.env.VITE_BEE_API_URL;
const pinnedBatch: string | undefined = import.meta.env
  .VITE_SWARM_POSTAGE_BATCH_ID;

/** Whether Swarm storage is configured (sync, before any probing). */
export const swarmEnabled = Boolean(beeUrl);

/** Node reachability / write capability, surfaced to the UI. */
export type SwarmNodeState =
  | { kind: 'connecting' }
  | { kind: 'ready'; batchId: string }
  | { kind: 'read-only'; reason: string }
  | { kind: 'unreachable'; reason: string };

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
  const [nodeState, setNodeState] = useState<SwarmNodeState>(() =>
    swarmEnabled ? { kind: 'connecting' } : { kind: 'unreachable', reason: '' },
  );
  /** Adopt a batch bought during the session, without a reload. */
  const adoptBatch = useCallback((batchId: string) => {
    setNodeState({ kind: 'ready', batchId });
  }, []);
  const [stampHealth, setStampHealth] = useState<StampHealth | null>(null);
  const [progress, setProgress] = useState<SwarmProgress | null>(null);
  // Progress handler identity must stay stable — it is baked into the
  // storage config, and a new identity would rebuild the storage object.
  const onProgress = useCallback((p: SwarmProgress) => setProgress(p), []);
  const progressRef = useRef(onProgress);
  progressRef.current = onProgress;

  // Bumped to re-run the probe — the "check again" remedy, and after a
  // postage change settles.
  const [probe, setProbe] = useState(0);
  const recheck = useCallback(() => setProbe((n) => n + 1), []);

  useEffect(() => {
    if (!beeUrl) return;
    let cancelled = false;
    (async () => {
      // 1. Is the node reachable at all? (cheap, local to the node)
      try {
        await swarmFetch({ beeUrl }, '/health', { timeoutMs: 10_000 });
      } catch (error) {
        if (cancelled) return;
        const reason = (error as Error).message;
        console.warn(`Swarm: Bee node not reachable at ${beeUrl}`, error);
        setNodeState({ kind: 'unreachable', reason });
        return;
      }
      if (cancelled) return;

      // 2. A postage batch is needed only for writing. Without one the
      //    document still opens — read-only.
      try {
        const batchId =
          pinnedBatch ??
          (await listStamps({ beeUrl })).find((s) => s.usable)?.batchID;
        if (cancelled) return;
        if (!batchId) {
          console.info(
            `Swarm: no usable postage batch on ${beeUrl} — read-only ` +
              `(buy a batch to save; reading never needs one)`,
          );
          setNodeState({
            kind: 'read-only',
            reason: 'This Bee node has no usable postage batch',
          });
          return;
        }
        console.info(
          `Swarm: storing images and documents via ${beeUrl} (batch ${batchId.slice(0, 8)}…)`,
        );
        setNodeState({ kind: 'ready', batchId });
      } catch (error) {
        if (cancelled) return;
        console.warn('Swarm: postage batch lookup failed', error);
        setNodeState({
          kind: 'read-only',
          reason: (error as Error).message,
        });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [probe]);

  // Declared before the health ping that maintains it (hoisted state).
  const [nodeReachable, setNodeReachable] = useState(true);
  // Writing needs both a batch and a node that is actually answering: a
  // node that stops mid-session must hold content back, not fail saves.
  const canWrite = nodeState.kind === 'ready' && nodeReachable;
  const batchId = nodeState.kind === 'ready' ? nodeState.batchId : undefined;
  /** Usable for reads as soon as the node answers, batch or not. */
  const nodeUsable = nodeState.kind === 'ready' || nodeState.kind === 'read-only';

  const storageConfig: SwarmStorageConfig | null = useMemo(
    () =>
      beeUrl && nodeUsable
        ? { beeUrl, postageBatchId: batchId, onProgress }
        : null,
    [nodeUsable, batchId, onProgress],
  );

  const docStorage: SwarmDocumentStorage | null = useMemo(() => {
    if (!storageConfig) return null;
    const keys = resolveKeys(docId, generatePrivateKey, generateDocumentKey);
    return createSwarmDocumentStorage({
      ...storageConfig,
      ownerPrivateKey: keys.owner as `0x${string}`,
      documentKey: keys.doc,
    });
  }, [storageConfig, docId]);

  const imageFns = useMemo(
    () =>
      storageConfig
        ? {
            imageUploadFn: canWrite
              ? createSwarmImageUploadFn(storageConfig)
              : undefined,
            imageFetchFn: createSwarmImageFetchFn(storageConfig),
          }
        : { imageUploadFn: undefined, imageFetchFn: undefined },
    [storageConfig, canWrite],
  );

  // Conditions are only as fresh as their inputs: the browser can go
  // offline and the node can stop after the initial probe, so both are
  // watched for as long as the document is open.
  const [online, setOnline] = useState(() =>
    typeof navigator === 'undefined' ? true : navigator.onLine,
  );
  useEffect(() => {
    const update = () => setOnline(navigator.onLine);
    window.addEventListener('online', update);
    window.addEventListener('offline', update);
    return () => {
      window.removeEventListener('online', update);
      window.removeEventListener('offline', update);
    };
  }, []);

  useEffect(() => {
    if (!beeUrl || nodeState.kind === 'connecting') return;
    let cancelled = false;
    const ping = async () => {
      try {
        await swarmFetch({ beeUrl }, '/health', { timeoutMs: 5_000 });
        if (!cancelled) setNodeReachable(true);
      } catch {
        if (!cancelled) setNodeReachable(false);
      }
    };
    ping();
    const id = setInterval(ping, 30_000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [nodeState.kind, probe]);

  // Stamp health follows whichever batch is in use, including one bought
  // mid-session.
  useEffect(() => {
    if (!beeUrl || !batchId) return;
    let cancelled = false;
    checkStampHealth({ beeUrl }, batchId)
      .then((health) => !cancelled && setStampHealth(health))
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [batchId]);

  return {
    ...imageFns,
    docStorage,
    stampHealth,
    nodeState,
    canWrite,
    progress,
    adoptBatch,
    beeUrl,
    batchId,
    /** Inputs for `diagnoseSwarm`, kept current while the document is open. */
    diagnosticsInput: {
      online,
      nodeReachable: nodeReachable && nodeState.kind !== 'unreachable',
      stamp: stampHealth,
      hasBatch: Boolean(batchId),
      localFallback: 'browser' as const,
    },
    recheck,
  };
};
