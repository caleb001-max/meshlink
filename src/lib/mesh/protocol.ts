// Wire protocol shared by every transport.
// Framing: newline-delimited JSON over the wire. Relay hops decrement `ttl`.
import { randomId } from '../codec';

export const MESH_PORT = 47474;
export const DEFAULT_TTL = 5;

export type EnvelopeType =
  | 'HELLO'
  | 'MSG'
  | 'ACK'
  | 'CALL_OFFER'
  | 'CALL_ANSWER'
  | 'CALL_END';

export interface Envelope {
  v: 1;
  id: string;
  type: EnvelopeType;
  /** sender public key (hex) */
  src: string;
  srcName: string;
  /** recipient public key (hex), or '*' for broadcast */
  dst: string;
  ttl: number;
  ts: number;
  body: unknown;
}

export interface HelloBody {
  name: string;
  pk: string;
}

export interface MsgBody {
  /** encrypted-for-recipient payload: JSON({mid, kind, text, media}) */
  cipher: string;
}

export interface AckBody {
  of: string;
}

export interface DecryptedPayload {
  mid: string;
  kind: 'text' | 'photo' | 'audio';
  text: string;
  media: string | null;
}

export function makeEnvelope(
  type: EnvelopeType,
  src: string,
  srcName: string,
  dst: string,
  ttl: number,
  body: unknown,
): Envelope {
  return { v: 1, id: randomId(), type, src, srcName, dst, ttl, ts: Date.now(), body };
}
