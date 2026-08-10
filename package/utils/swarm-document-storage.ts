import {
  SwarmFeedConfig,
  concatBytes,
  feedOwnerAddress,
  makeFeedTopic,
  readFeedUpdate,
  readLatestFeedIndex,
  uint64BigEndian,
  writeFeedUpdate,
} from './swarm-feeds';

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

const toBase64 = (bytes: Uint8Array): string => {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
};

const fromBase64 = (value: string): Uint8Array<ArrayBuffer> => {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
};

const hexToBytes = (hex: string): Uint8Array =>
  new Uint8Array((hex.match(/../g) as string[]).map((b) => parseInt(b, 16)));

const bytesToHex = (bytes: Uint8Array): string =>
  Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');

const readUint64BigEndian = (bytes: Uint8Array): number =>
  Number(new DataView(bytes.buffer, bytes.byteOffset, 8).getBigUint64(0));

const stripTrailingSlash = (url: string) => url.replace(/\/+$/, '');

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
  const beeUrl = stripTrailingSlash(config.beeUrl);
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
    const response = await fetch(`${beeUrl}/bytes/${reference}`, {
      headers: config.headers,
    });
    if (!response.ok) {
      throw new Error(
        `Snapshot download failed: ${response.status} ${response.statusText}`,
      );
    }
    let bytes = new Uint8Array(await response.arrayBuffer());
    const key = await cryptoKey('decrypt');
    if (key) bytes = await unseal(key, bytes);
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
      const key = await cryptoKey('encrypt');
      const blob = key ? await seal(key, plaintext) : plaintext;

      const response = await fetch(`${beeUrl}/bytes`, {
        method: 'POST',
        headers: {
          'content-type': 'application/octet-stream',
          ...(config.postageBatchId
            ? { 'swarm-postage-batch-id': config.postageBatchId }
            : {}),
          ...config.headers,
        },
        body: blob,
      });
      if (!response.ok) {
        throw new Error(
          `Snapshot upload failed: ${response.status} ${response.statusText}`,
        );
      }
      const { reference } = (await response.json()) as { reference: string };

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
