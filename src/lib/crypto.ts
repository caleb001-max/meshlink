// Identity (Curve25519 keypair) + end-to-end message encryption using tweetnacl.
// Messages are encrypted to the recipient's public key, so relay hops cannot read
// them (same model Briar uses). Relays only ever see ciphertext.
import * as nacl from 'tweetnacl';
import * as SecureStore from 'expo-secure-store';
import { bytesToB64, b64ToBytes, bytesToHex, hexToBytes, strToBytes, bytesToStr } from './codec';

const KEYS_STORE_KEY = 'chimera.keys.v1';

export interface Identity {
  pk: string; // hex public key
  sk: string; // hex secret key
}

let cachedIdentity: Identity | null = null;

export async function getIdentity(): Promise<Identity> {
  if (cachedIdentity) return cachedIdentity;
  const stored = await SecureStore.getItemAsync(KEYS_STORE_KEY);
  if (stored) {
    try {
      cachedIdentity = JSON.parse(stored) as Identity;
      return cachedIdentity;
    } catch {
      // fall through and regenerate
    }
  }
  const pair = nacl.box.keyPair();
  const fresh: Identity = { pk: bytesToHex(pair.publicKey), sk: bytesToHex(pair.secretKey) };
  await SecureStore.setItemAsync(KEYS_STORE_KEY, JSON.stringify(fresh));
  cachedIdentity = fresh;
  return fresh;
}

export async function wipeIdentity(): Promise<void> {
  cachedIdentity = null;
  await SecureStore.deleteItemAsync(KEYS_STORE_KEY);
}

/** SHA-512 hash (hex, first 64 chars) used to store the unlock code without keeping it. */
export function hashPasscode(code: string): string {
  const digest = nacl.hash(strToBytes(code));
  return bytesToHex(digest.subarray(0, 32));
}

/**
 * Encrypts a payload end-to-end for a specific recipient public key.
 * Returns base64(nonce || box) — only the holder of dstSk can open it.
 */
export function encryptFor(plaintext: string, dstPkHex: string, myIdentity: Identity): string {
  const nonce = nacl.randomBytes(nacl.box.nonceLength);
  const boxed = nacl.box(
    strToBytes(plaintext),
    nonce,
    hexToBytes(dstPkHex),
    hexToBytes(myIdentity.sk),
  );
  const payload = new Uint8Array(nonce.length + boxed.length);
  payload.set(nonce, 0);
  payload.set(boxed, nonce.length);
  return bytesToB64(payload);
}

/** Decrypts a payload produced by encryptFor. Throws if the ciphertext is not for us. */
export function decryptFrom(cipherB64: string, srcPkHex: string, myIdentity: Identity): string {
  const payload = b64ToBytes(cipherB64);
  const nonce = payload.subarray(0, nacl.box.nonceLength);
  const boxed = payload.subarray(nacl.box.nonceLength);
  const opened = nacl.box.open(boxed, nonce, hexToBytes(srcPkHex), hexToBytes(myIdentity.sk));
  if (!opened) throw new Error('Decryption failed');
  return bytesToStr(opened);
}
