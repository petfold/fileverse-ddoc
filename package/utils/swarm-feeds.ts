import { keccak256 } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

/**
 * Minimal Ethereum Swarm sequence-feed client over the Bee HTTP API.
 *
 * A feed is a mutable pointer built from single-owner chunks (SOCs): update
 * N of feed `(owner, topic)` is a chunk whose identifier is derived from the
 * topic and index, signed by the owner's key. Writing needs only
 * `POST /soc` and reading `GET /feeds` / `GET /chunks`, so — with `viem`
 * (already a peer dependency) supplying keccak256 and signing — no extra
 * dependency is required.
 *
 * Wire format compatibility: identifiers, chunk addressing (BMT) and the
 * Ethereum-personal-sign SOC signature follow the Swarm specs, so feeds
 * written here are readable by bee-js and vice versa.
 */

export interface SwarmFeedConfig {
  /** Base URL of the Bee node / gateway API, e.g. `http://localhost:1633`. */
  beeUrl: string;
  /** Postage batch ID paying for feed updates (required to write). */
  postageBatchId?: string;
  /** Extra headers sent with every request (e.g. gateway auth). */
  headers?: Record<string, string>;
}

const SEGMENT_SIZE = 32;
const CHUNK_SIZE = 4096;
const SOC_SIGNATURE_SIZE = 65;
const SOC_IDENTIFIER_SIZE = 32;
const SPAN_SIZE = 8;

export const concatBytes = (
  ...arrays: Uint8Array[]
): Uint8Array<ArrayBuffer> => {
  const out = new Uint8Array(arrays.reduce((n, a) => n + a.length, 0));
  let offset = 0;
  for (const a of arrays) {
    out.set(a, offset);
    offset += a.length;
  }
  return out;
};

export const bytesToHexString = (bytes: Uint8Array): string =>
  Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');

const utf8 = (value: string) => new TextEncoder().encode(value);

const stripTrailingSlash = (url: string) => url.replace(/\/+$/, '');

/** Chunk span: content length as uint64 little-endian. */
const spanBytes = (length: number): Uint8Array => {
  const bytes = new Uint8Array(SPAN_SIZE);
  new DataView(bytes.buffer).setBigUint64(0, BigInt(length), true);
  return bytes;
};

/** Feed index / timestamp: uint64 big-endian. */
export const uint64BigEndian = (value: number): Uint8Array => {
  const bytes = new Uint8Array(8);
  new DataView(bytes.buffer).setBigUint64(0, BigInt(value), false);
  return bytes;
};

const readUint64BigEndian = (bytes: Uint8Array): number =>
  Number(new DataView(bytes.buffer, bytes.byteOffset, 8).getBigUint64(0));

/** Binary Merkle Tree root over one zero-padded 4096-byte chunk. */
const bmtRoot = (payload: Uint8Array): Uint8Array => {
  if (payload.length > CHUNK_SIZE) {
    throw new Error(
      `Payload exceeds single chunk capacity (${payload.length} > ${CHUNK_SIZE})`,
    );
  }
  let level = new Uint8Array(CHUNK_SIZE);
  level.set(payload);
  while (level.length > SEGMENT_SIZE) {
    const next = new Uint8Array(level.length / 2);
    for (let i = 0; i < next.length; i += SEGMENT_SIZE) {
      next.set(
        keccak256(level.slice(i * 2, i * 2 + SEGMENT_SIZE * 2), 'bytes'),
        i,
      );
    }
    level = next;
  }
  return level;
};

/** Content address of a single chunk: keccak256(span || bmtRoot). */
export const chunkAddress = (payload: Uint8Array): Uint8Array =>
  keccak256(concatBytes(spanBytes(payload.length), bmtRoot(payload)), 'bytes');

/** Derive a 32-byte feed topic from a human-readable name. */
export const makeFeedTopic = (name: string): Uint8Array =>
  keccak256(utf8(name), 'bytes');

/** Sequence-feed SOC identifier: keccak256(topic || index_be64). */
const feedIdentifier = (topic: Uint8Array, index: number): Uint8Array =>
  keccak256(concatBytes(topic, uint64BigEndian(index)), 'bytes');

/** Ethereum address (lowercase, no 0x) owning feeds signed with this key. */
export const feedOwnerAddress = (privateKey: `0x${string}`): string =>
  privateKeyToAccount(privateKey).address.slice(2).toLowerCase();

/**
 * Sign and upload one sequence-feed update. Returns the SOC reference.
 * The payload must fit a single chunk (≤ 4096 bytes minus headers); larger
 * content should live on `/bytes` with only its reference in the feed.
 */
export const writeFeedUpdate = async (
  config: SwarmFeedConfig,
  ownerPrivateKey: `0x${string}`,
  topic: Uint8Array,
  index: number,
  payload: Uint8Array,
): Promise<string> => {
  const beeUrl = stripTrailingSlash(config.beeUrl);
  const account = privateKeyToAccount(ownerPrivateKey);
  const owner = account.address.slice(2).toLowerCase();

  const identifier = feedIdentifier(topic, index);
  const address = chunkAddress(payload);
  // SOC digest is signed with the Ethereum personal-message prefix so
  // ordinary wallet keys (and hardware signers) can own feeds.
  const digest = keccak256(concatBytes(identifier, address), 'bytes');
  const signature = await account.signMessage({ message: { raw: digest } });

  const response = await fetch(
    `${beeUrl}/soc/${owner}/${bytesToHexString(identifier)}?sig=${signature.slice(2)}`,
    {
      method: 'POST',
      headers: {
        'content-type': 'application/octet-stream',
        ...(config.postageBatchId
          ? { 'swarm-postage-batch-id': config.postageBatchId }
          : {}),
        ...config.headers,
      },
      body: concatBytes(spanBytes(payload.length), payload),
    },
  );
  if (!response.ok) {
    throw new Error(
      `Feed update failed: ${response.status} ${await response.text()}`,
    );
  }
  const { reference } = (await response.json()) as { reference: string };
  return reference;
};

/**
 * Look up the latest update index of a feed via `GET /feeds`.
 * Returns `null` when the feed has no updates yet.
 */
export const readLatestFeedIndex = async (
  config: SwarmFeedConfig,
  owner: string,
  topic: Uint8Array,
): Promise<{ index: number; nextIndex: number } | null> => {
  const beeUrl = stripTrailingSlash(config.beeUrl);
  const response = await fetch(
    `${beeUrl}/feeds/${owner}/${bytesToHexString(topic)}?type=sequence`,
    { headers: config.headers },
  );
  if (response.status === 404) return null;
  if (!response.ok) {
    throw new Error(
      `Feed lookup failed: ${response.status} ${response.statusText}`,
    );
  }
  const indexHex = response.headers.get('swarm-feed-index');
  const nextHex = response.headers.get('swarm-feed-index-next');
  if (!indexHex) {
    throw new Error('Feed lookup response missing swarm-feed-index header');
  }
  const index = parseInt(indexHex, 16);
  return { index, nextIndex: nextHex ? parseInt(nextHex, 16) : index + 1 };
};

/**
 * Read the payload of a specific feed update by index, fetching the SOC
 * directly by its address via `GET /chunks` (works for any historical
 * index, which `GET /feeds` does not expose). Returns `null` when that
 * update does not exist.
 */
export const readFeedUpdate = async (
  config: SwarmFeedConfig,
  owner: string,
  topic: Uint8Array,
  index: number,
): Promise<Uint8Array | null> => {
  const beeUrl = stripTrailingSlash(config.beeUrl);
  const identifier = feedIdentifier(topic, index);
  const ownerBytes = new Uint8Array(
    (owner.match(/../g) as string[]).map((b) => parseInt(b, 16)),
  );
  const socAddress = keccak256(concatBytes(identifier, ownerBytes), 'bytes');

  const response = await fetch(
    `${beeUrl}/chunks/${bytesToHexString(socAddress)}`,
    { headers: config.headers },
  );
  if (response.status === 404) return null;
  if (!response.ok) {
    throw new Error(
      `Feed chunk fetch failed: ${response.status} ${response.statusText}`,
    );
  }
  // SOC chunk layout: identifier(32) || signature(65) || span(8) || payload.
  const data = new Uint8Array(await response.arrayBuffer());
  const payloadStart = SOC_IDENTIFIER_SIZE + SOC_SIGNATURE_SIZE + SPAN_SIZE;
  const spanStart = SOC_IDENTIFIER_SIZE + SOC_SIGNATURE_SIZE;
  const length = readUint64BigEndian(data.slice(spanStart, payloadStart));
  return data.slice(payloadStart, payloadStart + length);
};
