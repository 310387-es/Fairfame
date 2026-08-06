import { createCipheriv, createDecipheriv, randomBytes, timingSafeEqual } from "node:crypto";
import { getEnv } from "./env.ts";

/**
 * The token vault — envelope encryption for OAuth credentials at rest.
 *
 * `connections.encrypted_tokens` holds a provider's access and refresh tokens.
 * A refresh token is a long-lived key to a customer's Google Business Profile,
 * so a database dump must not be enough to use one.
 *
 * Envelope encryption, not plain AES with one key:
 *
 *   plaintext ──AES-256-GCM──▶ ciphertext        (data key, fresh per secret)
 *   data key  ──AES-256-GCM──▶ wrapped data key  (key-encryption key, from env)
 *
 * The point is rotation. Rotating the KEK means re-wrapping small data keys
 * rather than decrypting and re-encrypting every token in the table, and a
 * compromised single ciphertext exposes one data key rather than the corpus.
 *
 * Every payload carries the id of the KEK that wrapped it, so old keys keep
 * working for decryption while new writes use the active one — a rotation is a
 * config change and a background re-wrap, never a downtime window.
 *
 * ## Additional authenticated data
 *
 * Both layers are bound to a caller-supplied context string (in practice
 * `connection:<uuid>`). GCM authenticates it without encrypting it, so a
 * ciphertext copied from one connection's row into another's fails to decrypt
 * instead of silently handing the second tenant the first one's tokens. That is
 * the attack RLS cannot see, because at that point the row is legitimately the
 * attacker's own.
 *
 * ## Configuration
 *
 *   TOKEN_VAULT_KEYS="k2:<base64 32 bytes>,k1:<base64 32 bytes>"
 *
 * The first entry is active and used for all new writes; the rest exist only to
 * read payloads written before the last rotation. Generate one with:
 *
 *   node -e "console.log(require('node:crypto').randomBytes(32).toString('base64'))"
 */

const ALGORITHM = "aes-256-gcm";
const KEY_BYTES = 32;
/** 96-bit nonces are what GCM is specified for; anything else invites reuse bugs. */
const IV_BYTES = 12;
const TAG_BYTES = 16;
const FORMAT_VERSION = "v1";

export class VaultError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VaultError";
  }
}

export type VaultKey = { id: string; key: Buffer };

/** base64url without padding — these strings travel in a dot-delimited payload. */
function encode(buffer: Buffer): string {
  return buffer.toString("base64url");
}

function decode(value: string, label: string): Buffer {
  const buffer = Buffer.from(value, "base64url");
  if (buffer.length === 0) throw new VaultError(`Vault payload has an empty ${label}.`);
  return buffer;
}

/**
 * Parses `TOKEN_VAULT_KEYS`. The first entry is the active key.
 *
 * Fails loudly on a malformed or short key: a 16-byte "AES-256" key is the kind
 * of mistake that works perfectly in dev and is a finding in an audit.
 */
export function parseVaultKeys(raw: string): VaultKey[] {
  const keys: VaultKey[] = [];
  const seen = new Set<string>();

  for (const entry of raw.split(",")) {
    const trimmed = entry.trim();
    if (trimmed === "") continue;

    const separator = trimmed.indexOf(":");
    if (separator <= 0) {
      throw new VaultError(`Vault key entry "${trimmed}" must be in the form "<id>:<base64 key>".`);
    }

    const id = trimmed.slice(0, separator).trim();
    const material = Buffer.from(trimmed.slice(separator + 1).trim(), "base64");

    if (!/^[A-Za-z0-9_-]{1,32}$/.test(id)) {
      throw new VaultError(`Vault key id "${id}" must be 1–32 characters of [A-Za-z0-9_-].`);
    }
    if (seen.has(id)) throw new VaultError(`Vault key id "${id}" appears more than once.`);
    if (material.length !== KEY_BYTES) {
      throw new VaultError(
        `Vault key "${id}" must be ${KEY_BYTES} bytes of base64, got ${material.length}.`,
      );
    }

    seen.add(id);
    keys.push({ id, key: material });
  }

  if (keys.length === 0) throw new VaultError("TOKEN_VAULT_KEYS is empty.");
  return keys;
}

let cachedKeys: VaultKey[] | undefined;

function vaultKeys(): VaultKey[] {
  if (cachedKeys) return cachedKeys;

  const raw = getEnv().TOKEN_VAULT_KEYS;
  if (!raw) {
    throw new VaultError(
      "TOKEN_VAULT_KEYS is not configured, so credentials cannot be stored. " +
        "Generate a key with: node -e \"console.log(require('node:crypto').randomBytes(32).toString('base64'))\"",
    );
  }

  cachedKeys = parseVaultKeys(raw);
  return cachedKeys;
}

/**
 * Whether the vault can be used at all.
 *
 * Provider mode resolution consults this: a provider cannot go `real` without
 * somewhere safe to put the tokens it is about to receive.
 */
export function isVaultConfigured(): boolean {
  const raw = getEnv().TOKEN_VAULT_KEYS;
  if (!raw) return false;

  try {
    parseVaultKeys(raw);
    return true;
  } catch {
    return false;
  }
}

/** Test-only: drop the parsed-key cache after changing the environment. */
export function resetVaultKeysForTesting(): void {
  cachedKeys = undefined;
}

/**
 * Test-only: install keys directly, without a configured environment. Lets the
 * crypto be tested on its own terms rather than through env validation.
 */
export function setVaultKeysForTesting(raw: string | null): void {
  cachedKeys = raw === null ? undefined : parseVaultKeys(raw);
}

function activeKey(): VaultKey {
  const [key] = vaultKeys();
  if (!key) throw new VaultError("No active vault key.");
  return key;
}

function keyById(id: string): VaultKey {
  const match = vaultKeys().find((candidate) => {
    // Constant-time compare on the id as well: it is attacker-visible in the
    // payload, and there is no reason to leak a comparison timing signal.
    const a = Buffer.from(candidate.id);
    const b = Buffer.from(id);
    return a.length === b.length && timingSafeEqual(a, b);
  });

  if (!match) {
    throw new VaultError(
      `Vault key "${id}" is not configured. A payload encrypted with a retired key ` +
        "cannot be read until that key is restored to TOKEN_VAULT_KEYS.",
    );
  }
  return match;
}

function seal(key: Buffer, plaintext: Buffer, aad: Buffer): { iv: Buffer; body: Buffer } {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  cipher.setAAD(aad);

  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  // Tag appended rather than carried separately: one field to serialize, and
  // impossible to forget when reading it back.
  return { iv, body: Buffer.concat([encrypted, cipher.getAuthTag()]) };
}

function open(key: Buffer, iv: Buffer, body: Buffer, aad: Buffer): Buffer {
  if (body.length <= TAG_BYTES) throw new VaultError("Vault payload is truncated.");

  const tag = body.subarray(body.length - TAG_BYTES);
  const encrypted = body.subarray(0, body.length - TAG_BYTES);

  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAAD(aad);
  decipher.setAuthTag(tag);

  return Buffer.concat([decipher.update(encrypted), decipher.final()]);
}

/**
 * Encrypts a secret under a fresh data key.
 *
 * `context` binds the result to where it is stored — pass the same string to
 * `decryptSecret`, or authentication fails. Use `connectionContext()`.
 */
export function encryptSecret(plaintext: string, context: string): string {
  if (context.length === 0) throw new VaultError("A vault context is required.");

  const kek = activeKey();
  const aad = Buffer.from(context, "utf8");

  const dataKey = randomBytes(KEY_BYTES);
  try {
    const sealed = seal(dataKey, Buffer.from(plaintext, "utf8"), aad);
    // The wrapped key is bound to the key id as well, so a payload cannot be
    // relabelled as having been wrapped by a different KEK.
    const wrapped = seal(kek.key, dataKey, Buffer.from(`${kek.id}:${context}`, "utf8"));

    return [
      FORMAT_VERSION,
      kek.id,
      encode(wrapped.iv),
      encode(wrapped.body),
      encode(sealed.iv),
      encode(sealed.body),
    ].join(".");
  } finally {
    // Not a guarantee under a copying GC, but it shortens the window in which
    // the data key sits in a reusable buffer.
    dataKey.fill(0);
  }
}

export function decryptSecret(payload: string, context: string): string {
  const parts = payload.split(".");
  if (parts.length !== 6) {
    throw new VaultError("Vault payload is malformed.");
  }

  const [version, keyId, wrappedIv, wrappedBody, iv, body] = parts as [
    string,
    string,
    string,
    string,
    string,
    string,
  ];

  if (version !== FORMAT_VERSION) {
    throw new VaultError(`Unsupported vault payload version "${version}".`);
  }

  const kek = keyById(keyId);
  const aad = Buffer.from(context, "utf8");

  let dataKey: Buffer | undefined;
  try {
    dataKey = open(
      kek.key,
      decode(wrappedIv, "wrapped key iv"),
      decode(wrappedBody, "wrapped key"),
      Buffer.from(`${kek.id}:${context}`, "utf8"),
    );

    return open(dataKey, decode(iv, "iv"), decode(body, "ciphertext"), aad).toString("utf8");
  } catch (error) {
    if (error instanceof VaultError) throw error;
    // GCM authentication failures are deliberately opaque: a wrong key, a wrong
    // context and a tampered ciphertext must be indistinguishable to a caller.
    throw new VaultError("Could not decrypt the vault payload.");
  } finally {
    dataKey?.fill(0);
  }
}

/** Which KEK sealed this payload. Used by a rotation sweep to find stale rows. */
export function keyIdOf(payload: string): string | null {
  const parts = payload.split(".");
  return parts.length === 6 && parts[0] === FORMAT_VERSION ? (parts[1] ?? null) : null;
}

/** True when the payload was written under a key that is no longer active. */
export function needsRewrap(payload: string): boolean {
  const id = keyIdOf(payload);
  return id !== null && id !== activeKey().id;
}

/** Re-seals a payload under the active key. The rotation primitive. */
export function rewrapSecret(payload: string, context: string): string {
  return encryptSecret(decryptSecret(payload, context), context);
}

/**
 * The binding context for a connection's credentials.
 *
 * Keyed on the connection's *slot* — organization, location, provider — rather
 * than its row id, for two reasons. It is known before the row exists, which
 * the OAuth callback needs (it encrypts tokens as part of creating the
 * connection); and `unique(location_id, provider)` means a slot identifies
 * exactly one row anyway, so the binding is no weaker. Copying a token blob
 * into another tenant's row, or another provider's, still fails to decrypt.
 */
export function connectionContext(
  organizationId: string,
  locationId: string,
  provider: string,
): string {
  return `connection:${organizationId}:${locationId}:${provider}`;
}

/**
 * The binding context for a **channel's** credentials (W2.2).
 *
 * Its own prefix rather than a reuse of `connectionContext` with a placeholder
 * location, and that is the whole point of the separate context: a channel has
 * no location, so any stand-in — an empty string, the organization id again —
 * would be a value somebody could also produce on the source side, and the two
 * blobs would become interchangeable. A distinct prefix means a WhatsApp
 * *channel* token cannot be moved into a WhatsApp *source* row and decrypted,
 * even though both are the same organization and the same provider name.
 *
 * Keyed on the slot for the same reason as above: `unique(organization_id,
 * channel)` makes it identify exactly one row, and it is known before the row
 * exists, which the OAuth callback needs.
 */
export function channelContext(organizationId: string, channel: string): string {
  return `channel:${organizationId}:${channel}`;
}
