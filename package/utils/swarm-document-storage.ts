import {
  SwarmFeedConfig,
  feedOwnerAddress,
  makeFeedTopic,
  readFeedUpdate,
  readLatestFeedIndex,
  uint64BigEndian,
  writeFeedUpdate,
} from './swarm-feeds';
import {
  bytesToHex,
  concatBytes,
  fromBase64,
  hexToBytes,
  readWithProgress,
  swarmFetch,
  toBase64,
} from './swarm-common';

/**
 * Document persistence on Ethereum Swarm.
 *
 * Each save uploads an (optionally AES-256-GCM encrypted) snapshot of the
 * document to `/bytes` — an immutable, content-addressed version — and
 * advances a sequence feed owned by `ownerPrivateKey` to point at it. The
 * feed is the mutable "latest" pointer; historical feed indices double as
 * version history for free.
 *
 * Feed update payload: `timestamp_be64_seconds || swarm reference` (the
 * layout bee-js uses for reference feeds, so other Swarm tooling can follow
 * the pointer).
 *
 * Host wiring: call `saveDocument` (debounced) from the editor's `onChange`
 * with the serialized document, and feed `loadDocument(...)` into
 * `initialContent` on open. One storage instance may persist any number of
 * documents — the feed topic is derived per `ddocId`.
 *
 * Single-writer by design: sequence feeds have one owner key. Concurrent
 * saves of the same document race on the next index (last write wins).
 */

export interface SwarmDocumentStorageConfig extends SwarmFeedConfig {
  /**
   * secp256k1 private key (0x-hex) owning the document feeds. An ordinary
   * Ethereum account key works; generate a dedicated one with viem's
   * `generatePrivateKey()` if the wallet key should not sign storage
   * updates silently.
   */
  ownerPrivateKey: `0x${string}`;
  /**
   * Base64-encoded 32-byte AES key encrypting snapshots; create one with
   * {@link generateDocumentKey}. Omit to store documents in plaintext
   * (public documents).
   */
  documentKey?: string;
}

/** True when this storage can write — i.e. a postage batch is configured. */
export const canSaveToSwarm = (config: SwarmDocumentStorageConfig): boolean =>
  Boolean(config.postageBatchId);

export interface DocumentSnapshot {
  /** Decrypted snapshot bytes as saved. */
  bytes: Uint8Array;
  /** Convenience UTF-8 decoding of `bytes`. */
  text: string;
  /** Swarm reference of the (encrypted) snapshot blob. */
  reference: string;
  /** Feed index this snapshot was read from (version number). */
  feedIndex: number;
  /** Unix seconds recorded at save time. */
  timestamp: number;
}

export interface DocumentVersion {
  index: number;
  timestamp: number;
  reference: string;
}

const GCM_NONCE_BYTES = 12;
const TIMESTAMP_BYTES = 8;

const readUint64BigEndian = (bytes: Uint8Array): number =>
  Number(new DataView(bytes.buffer, bytes.byteOffset, 8).getBigUint64(0));

/** Namespaced feed topic for one document. */
export const makeDocumentFeedTopic = (ddocId: string): Uint8Array =>
  makeFeedTopic(`ddoc/v1/${ddocId}`);

/** Generate a base64 32-byte AES key for `documentKey`. */
export const generateDocumentKey = (): string =>
  toBase64(crypto.getRandomValues(new Uint8Array(32)));

/**
 * Encrypted blob layout: nonce(12) || WebCrypto AES-GCM output (ciphertext
 * with the 16-byte auth tag appended) — self-contained, so a snapshot is
 * decryptable from the blob plus `documentKey` alone.
 */
const seal = async (key: CryptoKey, plaintext: Uint8Array<ArrayBuffer>) => {
  const nonce = crypto.getRandomValues(new Uint8Array(GCM_NONCE_BYTES));
  const sealed = new Uint8Array(
    await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, key, plaintext),
  );
  return concatBytes(nonce, sealed);
};

const unseal = async (key: CryptoKey, blob: Uint8Array) => {
  const nonce = blob.slice(0, GCM_NONCE_BYTES);
  const sealed = blob.slice(GCM_NONCE_BYTES);
  return new Uint8Array(
    await crypto.subtle.decrypt({ name: 'AES-GCM', iv: nonce }, key, sealed),
  );
};

export const createSwarmDocumentStorage = (
  config: SwarmDocumentStorageConfig,
) => {
  const ownerAddress = feedOwnerAddress(config.ownerPrivateKey);
  // Feed-index cache: `GET /feeds` on a live node resolves over the network
  // (seconds, and slowest when the feed does not exist yet), so only the
  // first operation per document pays for it; afterwards saves advance the
  // cached index locally.
  const nextIndexCache = new Map<string, number>();

  const cryptoKey = async (usage: KeyUsage) =>
    config.documentKey
      ? crypto.subtle.importKey(
          'raw',
          fromBase64(config.documentKey),
          { name: 'AES-GCM' },
          false,
          [usage],
        )
      : null;

  const fetchSnapshot = async (
    reference: string,
    feedIndex: number,
    timestamp: number,
  ): Promise<DocumentSnapshot> => {
    config.onProgress?.({ stage: 'download', status: 'start' });
    const response = await swarmFetch(config, `/bytes/${reference}`);
    if (response.status === 404) {
      throw new Error(`Snapshot not found on Swarm: ${reference}`);
    }
    let bytes: Uint8Array = await readWithProgress(response, config.onProgress);
    const key = await cryptoKey('decrypt');
    if (key) {
      config.onProgress?.({ stage: 'decrypt', status: 'start' });
      bytes = await unseal(key, bytes);
      config.onProgress?.({ stage: 'decrypt', status: 'done' });
    }
    return {
      bytes,
      text: new TextDecoder().decode(bytes),
      reference,
      feedIndex,
      timestamp,
    };
  };

  const parseFeedPayload = (payload: Uint8Array) => ({
    timestamp: readUint64BigEndian(payload.slice(0, TIMESTAMP_BYTES)),
    reference: bytesToHex(payload.slice(TIMESTAMP_BYTES)),
  });

  return {
    ownerAddress,

    /**
     * Upload a snapshot and advance the document's feed to it.
     * Returns the immutable reference and the feed index it became.
     */
    saveDocument: async (
      ddocId: string,
      content: string | Uint8Array<ArrayBuffer>,
    ): Promise<DocumentVersion> => {
      const plaintext =
        typeof content === 'string'
          ? new TextEncoder().encode(content)
          : content;
      if (!config.postageBatchId) {
        throw new Error(
          'Saving to Swarm needs a postage batch. This node has none, so the ' +
            'document is read-only here (reading never needs a stamp).',
        );
      }
      const key = await cryptoKey('encrypt');
      const blob = key ? await seal(key, plaintext) : plaintext;

      config.onProgress?.({
        stage: 'upload',
        status: 'start',
        total: blob.length,
      });
      const response = await swarmFetch(config, '/bytes', {
        method: 'POST',
        headers: {
          'content-type': 'application/octet-stream',
          'swarm-postage-batch-id': config.postageBatchId,
        },
        body: blob,
      });
      if (response.status === 404) {
        throw new Error('Snapshot upload failed: node rejected the upload');
      }
      const { reference } = (await response.json()) as { reference: string };
      config.onProgress?.({
        stage: 'upload',
        status: 'done',
        loaded: blob.length,
        total: blob.length,
      });

      const topic = makeDocumentFeedTopic(ddocId);
      let index = nextIndexCache.get(ddocId);
      if (index === undefined) {
        const latest = await readLatestFeedIndex(config, ownerAddress, topic);
        index = latest ? latest.nextIndex : 0;
      }
      const timestamp = Math.floor(Date.now() / 1000);
      await writeFeedUpdate(
        config,
        config.ownerPrivateKey,
        topic,
        index,
        concatBytes(uint64BigEndian(timestamp), hexToBytes(reference)),
      );
      nextIndexCache.set(ddocId, index + 1);
      return { index, timestamp, reference };
    },

    /** Load the latest snapshot, or `null` for a never-saved document. */
    loadDocument: async (ddocId: string): Promise<DocumentSnapshot | null> => {
      const topic = makeDocumentFeedTopic(ddocId);
      const latest = await readLatestFeedIndex(config, ownerAddress, topic);
      if (!latest) return null;
      nextIndexCache.set(ddocId, latest.nextIndex);
      const payload = await readFeedUpdate(
        config,
        ownerAddress,
        topic,
        latest.index,
      );
      if (!payload) return null;
      const { timestamp, reference } = parseFeedPayload(payload);
      return fetchSnapshot(reference, latest.index, timestamp);
    },

    /** Load one historical version by feed index. */
    loadDocumentVersion: async (
      ddocId: string,
      index: number,
    ): Promise<DocumentSnapshot | null> => {
      const topic = makeDocumentFeedTopic(ddocId);
      const payload = await readFeedUpdate(config, ownerAddress, topic, index);
      if (!payload) return null;
      const { timestamp, reference } = parseFeedPayload(payload);
      return fetchSnapshot(reference, index, timestamp);
    },

    /** Enumerate all saved versions (feed indices 0..latest), oldest first. */
    listDocumentVersions: async (
      ddocId: string,
    ): Promise<DocumentVersion[]> => {
      const topic = makeDocumentFeedTopic(ddocId);
      const latest = await readLatestFeedIndex(config, ownerAddress, topic);
      if (!latest) return [];
      const payloads = await Promise.all(
        Array.from({ length: latest.index + 1 }, (_, i) =>
          readFeedUpdate(config, ownerAddress, topic, i),
        ),
      );
      return payloads.flatMap((payload, index) => {
        if (!payload) return [];
        const { timestamp, reference } = parseFeedPayload(payload);
        return [{ index, timestamp, reference }];
      });
    },
  };
};

export type SwarmDocumentStorage = ReturnType<
  typeof createSwarmDocumentStorage
>;
