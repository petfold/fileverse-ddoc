import { ImageFetchFn, ImageUploadFn } from '../types';

/**
 * Ethereum Swarm storage adapter for the storage-agnostic image props.
 *
 * Produces `imageUploadFn` / `imageFetchFn` implementations backed by a Bee
 * node's HTTP API (`POST /bytes`, `GET /bytes/{reference}`), using plain
 * `fetch` and WebCrypto — no extra dependencies. Images are AES-256-GCM
 * encrypted client-side before upload, matching the editor's contract that
 * only ciphertext leaves the client; the Bee node never sees plaintext or
 * keys. `contentRef` is the Swarm reference (64-hex), `url` the node's
 * `/bytes` location of the ciphertext.
 *
 * Usage:
 * ```ts
 * const swarm = { beeUrl: 'http://localhost:1633', postageBatchId: '...' };
 * <DdocEditor
 *   imageUploadFn={createSwarmImageUploadFn(swarm)}
 *   imageFetchFn={createSwarmImageFetchFn(swarm)}
 * />
 * ```
 */

export interface SwarmStorageConfig {
  /** Base URL of the Bee node / gateway API, e.g. `http://localhost:1633`. */
  beeUrl: string;
  /**
   * Postage batch ID used to pay for uploads. Required for
   * `createSwarmImageUploadFn`; unused by fetch. When uploading through a
   * stamping gateway that attaches its own stamp, pass an empty string and
   * the header is omitted.
   */
  postageBatchId?: string;
  /** Extra headers sent with every request (e.g. gateway auth). */
  headers?: Record<string, string>;
  /**
   * Defer chunk propagation to the node (`swarm-deferred-upload: true`,
   * Bee's default). Set `false` to wait until data is fully synced to the
   * network before the upload resolves.
   */
  deferred?: boolean;
}

const GCM_TAG_BYTES = 16;
const GCM_NONCE_BYTES = 12;

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

const stripTrailingSlash = (url: string) => url.replace(/\/+$/, '');

/**
 * Create an `imageUploadFn` that AES-256-GCM encrypts the file and uploads
 * the ciphertext to Swarm via the Bee `/bytes` endpoint.
 */
export const createSwarmImageUploadFn = (
  config: SwarmStorageConfig,
): ImageUploadFn => {
  const beeUrl = stripTrailingSlash(config.beeUrl);
  return async (file: File) => {
    const plaintext = await file.arrayBuffer();

    const key = await crypto.subtle.generateKey(
      { name: 'AES-GCM', length: 256 },
      true,
      ['encrypt'],
    );
    const nonce = crypto.getRandomValues(new Uint8Array(GCM_NONCE_BYTES));
    // WebCrypto appends the GCM auth tag to the ciphertext; split it off so
    // the tag travels as the editor's separate `authTag` parameter.
    const sealed = new Uint8Array(
      await crypto.subtle.encrypt(
        { name: 'AES-GCM', iv: nonce },
        key,
        plaintext,
      ),
    );
    const ciphertext = sealed.slice(0, sealed.length - GCM_TAG_BYTES);
    const authTag = sealed.slice(sealed.length - GCM_TAG_BYTES);

    const headers: Record<string, string> = {
      'content-type': 'application/octet-stream',
      ...(config.postageBatchId
        ? { 'swarm-postage-batch-id': config.postageBatchId }
        : {}),
      ...(config.deferred === false
        ? { 'swarm-deferred-upload': 'false' }
        : {}),
      ...config.headers,
    };
    const response = await fetch(`${beeUrl}/bytes`, {
      method: 'POST',
      headers,
      body: ciphertext,
    });
    if (!response.ok) {
      throw new Error(
        `Swarm upload failed: ${response.status} ${response.statusText}`,
      );
    }
    const { reference } = (await response.json()) as { reference: string };

    const rawKey = new Uint8Array(await crypto.subtle.exportKey('raw', key));
    return {
      encryptionKey: toBase64(rawKey),
      nonce: toBase64(nonce),
      authTag: toBase64(authTag),
      url: `${beeUrl}/bytes/${reference}`,
      contentRef: reference,
    };
  };
};

/**
 * Create an `imageFetchFn` that downloads ciphertext from Swarm and decrypts
 * it back into the image. Counterpart of {@link createSwarmImageUploadFn}.
 */
export const createSwarmImageFetchFn = (
  config: SwarmStorageConfig,
): ImageFetchFn => {
  const beeUrl = stripTrailingSlash(config.beeUrl);
  return async ({
    encryptionKey,
    nonce,
    authTag,
    mimeType,
    url,
    contentRef,
  }) => {
    // Prefer re-deriving the location from this config so documents render
    // even when the uploading host used a different Bee node.
    const location = contentRef ? `${beeUrl}/bytes/${contentRef}` : url;
    const response = await fetch(location, { headers: config.headers });
    if (!response.ok) {
      throw new Error(
        `Swarm download failed: ${response.status} ${response.statusText}`,
      );
    }
    const ciphertext = new Uint8Array(await response.arrayBuffer());

    const tag = fromBase64(authTag);
    const sealed = new Uint8Array(ciphertext.length + tag.length);
    sealed.set(ciphertext);
    sealed.set(tag, ciphertext.length);

    const key = await crypto.subtle.importKey(
      'raw',
      fromBase64(encryptionKey),
      { name: 'AES-GCM' },
      false,
      ['decrypt'],
    );
    const plaintext = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: fromBase64(nonce) },
      key,
      sealed,
    );

    const file = new File([plaintext], contentRef || 'image', {
      type: mimeType,
    });
    // jsdom/Node lack URL.createObjectURL; fall back to a data URL there.
    const objectUrl =
      typeof URL.createObjectURL === 'function'
        ? URL.createObjectURL(file)
        : `data:${mimeType};base64,${toBase64(new Uint8Array(plaintext))}`;
    return { url: objectUrl, file };
  };
};
