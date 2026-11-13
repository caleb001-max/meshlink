import { sha512 } from '@noble/hashes/sha2';
import { bytesToHex, utf8 } from './core/bytes';

/**
 * SHA-512 (first 32 bytes) of the unlock code, hex encoded.
 * Same construction as the pre-MeshLink build, so existing codes keep working.
 */
export function hashPasscode(code: string): string {
  return bytesToHex(sha512(utf8(code)).slice(0, 32));
}
