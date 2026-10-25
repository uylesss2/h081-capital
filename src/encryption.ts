// Memo encryption. Each note or allowance is encrypted to its recipient's
// viewing key (x25519), sealed with XChaCha20-Poly1305 under an ephemeral
// ECDH secret. Memo layout: ephemeralPub(32) | nonce(24) | ciphertext.
import { x25519 } from '@noble/curves/ed25519';
import { xchacha20poly1305 } from '@noble/ciphers/chacha';
import { hkdf } from '@noble/hashes/hkdf';
import { sha256 } from '@noble/hashes/sha256';
import { randomBytes, utf8ToBytes, bytesToUtf8, concatBytes, hexToBytes, bytesToHex } from '@noble/hashes/utils';

export interface ViewingKey { secret: Uint8Array; pub: Uint8Array }

/** Deterministic viewing key from a spending key, so one secret backs up everything. */
export function viewingKeyFromSk(sk: bigint): ViewingKey {
  const secret = sha256(utf8ToBytes('stipend/viewing/' + sk.toString()));
  return { secret, pub: x25519.getPublicKey(secret) };
}

export function randomViewingKey(): ViewingKey {
  const secret = randomBytes(32);
  return { secret, pub: x25519.getPublicKey(secret) };
}

function sealKey(shared: Uint8Array, ephPub: Uint8Array, recipientPub: Uint8Array): Uint8Array {
  return hkdf(sha256, shared, concatBytes(ephPub, recipientPub), utf8ToBytes('stipend/memo/v1'), 32);
}

export function encryptMemo(recipientPub: Uint8Array, plaintext: Uint8Array): Uint8Array {
  const eph = randomBytes(32);
  const ephPub = x25519.getPublicKey(eph);
  const key = sealKey(x25519.getSharedSecret(eph, recipientPub), ephPub, recipientPub);
  const nonce = randomBytes(24);
  const ct = xchacha20poly1305(key, nonce).encrypt(plaintext);
  return concatBytes(ephPub, nonce, ct);
}

/** Returns null if the memo is not for this key (wrong key or tampered). */
export function decryptMemo(vk: ViewingKey, memo: Uint8Array): Uint8Array | null {
  if (memo.length < 32 + 24 + 16) return null;
  const ephPub = memo.slice(0, 32);
  const nonce = memo.slice(32, 56);
  const ct = memo.slice(56);
  try {
    const key = sealKey(x25519.getSharedSecret(vk.secret, ephPub), ephPub, vk.pub);
    return xchacha20poly1305(key, nonce).decrypt(ct);
  } catch {
    return null;
  }
}

// ---- JSON payloads with bigint fields ----

// bigints are tagged ("n:<hex>") so that ordinary hex strings such as viewing keys survive the round trip.
export function encodePayload(obj: Record<string, unknown>): Uint8Array {
  return utf8ToBytes(JSON.stringify(obj, (_, v) => (typeof v === 'bigint' ? 'n:' + v.toString(16) : v)));
}

export function decodePayload<T = Record<string, unknown>>(bytes: Uint8Array): T {
  return JSON.parse(bytesToUtf8(bytes), (_, v) => (typeof v === 'string' && /^n:[0-9a-f]+$/.test(v) ? BigInt('0x' + v.slice(2)) : v));
}

export const toHex = (b: Uint8Array): string => '0x' + bytesToHex(b);
export const fromHex = (h: string): Uint8Array => hexToBytes(h.startsWith('0x') ? h.slice(2) : h);
