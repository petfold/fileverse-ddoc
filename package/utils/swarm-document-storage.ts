import {
  SwarmFeedConfig,
  feedOwnerAddress,
  makeFeedTopic,
  uint64BigEndian,
} from './swarm-feeds';
import {
  bytesToHex,
  concatBytes,
  fromBase64,
  hexToBytes,
  toBase64,
} from './swarm-common';
import { SwarmTransport, createBeeHttpTransport } from './swarm-transport';

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
  /**
   * How to reach Swarm. Defaults to this config's Bee node; pass a
   * provider transport (or the result of `detectSwarmTransport`) to run in
   * a browser that exposes `window.swarm` instead of a raw node API.
   */
  transport?: SwarmTransport;
}

/**
 * Whether this storage can write. Over the Bee HTTP API that means a
 * postage batch is configured; a provider transport manages postage
 * itself, so writing depends on its permission grant instead — ask
 * `transport.status()` there.
 */
export const canSaveToSwarm = (config: SwarmDocumentStorageConfig): boolean =>
  Boolean(config.transport?.managesPostage || config.postageBatchId);

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
  const transport =
    config.transport ??
    createBeeHttpTransport({
      ...config,
      ownerPrivateKey: config.ownerPrivateKey,
    });
  // Over HTTP the owner is derived from the local key and is known
  // synchronously; a provider supplies its own origin-scoped identity, so
  // the address is resolved on first use and cached.
  let ownerPromise: Promise<string> | null = null;
  const owner = () => (ownerPromise ??= transport.feedOwner());
  const ownerAddress = config.transport
    ? ''
    : feedOwnerAddress(config.ownerPrivateKey);
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
    let bytes: Uint8Array = await transport.downloadData(reference, {
      onProgress: config.onProgress,
    });
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
    /** Feed owner over HTTP; empty when a transport supplies the identity. */
    ownerAddress,
    /** Address that signs this document's feed, whichever transport is used. */
    feedOwner: owner,
    transport,

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
      const key = await cryptoKey('encrypt');
      const blob = key ? await seal(key, plaintext) : plaintext;
      const reference = await transport.uploadData(blob, {
        onProgress: config.onProgress,
      });

      const topic = makeDocumentFeedTopic(ddocId);
      const cached = nextIndexCache.get(ddocId);
      const index =
        cached ??
        (await transport.latestFeedIndex(await owner(), topic))?.nextIndex ??
        0;
      const timestamp = Math.floor(Date.now() / 1000);
      await transport.writeFeedUpdate(
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
      const feedOwner = await owner();
      const latest = await transport.latestFeedIndex(feedOwner, topic);
      if (!latest) return null;
      nextIndexCache.set(ddocId, latest.nextIndex);
      const payload = await transport.readFeedUpdate(
        feedOwner,
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
      const payload = await transport.readFeedUpdate(
        await owner(),
        topic,
        index,
      );
      if (!payload) return null;
      const { timestamp, reference } = parseFeedPayload(payload);
      return fetchSnapshot(reference, index, timestamp);
    },

    /** Enumerate all saved versions (feed indices 0..latest), oldest first. */
    listDocumentVersions: async (
      ddocId: string,
    ): Promise<DocumentVersion[]> => {
      const topic = makeDocumentFeedTopic(ddocId);
      const feedOwner = await owner();
      const latest = await transport.latestFeedIndex(feedOwner, topic);
      if (!latest) return [];
      const payloads = await Promise.all(
        Array.from({ length: latest.index + 1 }, (_, i) =>
          transport.readFeedUpdate(feedOwner, topic, i),
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
