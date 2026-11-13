/**
 * LAN transport for the MeshLink v2 node.
 *
 * A TCP stream carries raw MeshNode link frames (LinkCodec). Because TCP is a
 * byte stream, each node frame is prefixed with a 4-byte big-endian length so
 * handshake frames and sealed frames keep their boundaries. No JSON, no
 * readable metadata: everything inside the frame is already AEAD-sealed.
 */
import TcpSocket from 'react-native-tcp-socket';
import * as Network from 'expo-network';
import { concat } from '../core/bytes';
import type { MeshNode } from '../core/node';

export const LINK_PORT = 47474;

const SCAN_TIMEOUT_MS = 450;
const CONNECT_TIMEOUT_MS = 1600;
const WAVE_SIZE = 32;
const MAX_FRAME = 1_048_576;

interface FrameSocket {
  on(event: string, cb: (...args: unknown[]) => void): void;
  write(data: Uint8Array, encoding?: string, cb?: (err?: Error) => void): boolean;
  destroy(): void;
}

interface FrameServer {
  listen(options: { port: number; host: string }): void;
  on?(event: string, cb: (...args: unknown[]) => void): void;
  close(): void;
}

function lengthPrefix(bytes: Uint8Array): Uint8Array {
  const out = new Uint8Array(4 + bytes.length);
  out[0] = (bytes.length >>> 24) & 255;
  out[1] = (bytes.length >>> 16) & 255;
  out[2] = (bytes.length >>> 8) & 255;
  out[3] = bytes.length & 255;
  out.set(bytes, 4);
  return out;
}

function readLength(buf: Uint8Array, at: number): number {
  return ((buf[at] << 24) | (buf[at + 1] << 16) | (buf[at + 2] << 8) | buf[at + 3]) >>> 0;
}

/** Normalizes a react-native-tcp-socket data event (Buffer or string) to bytes. */
function toBytes(data: unknown): Uint8Array {
  if (typeof data === 'string') {
    const out = new Uint8Array(data.length);
    for (let i = 0; i < data.length; i++) out[i] = data.charCodeAt(i) & 255;
    return out;
  }
  if (data instanceof Uint8Array) return new Uint8Array(data);
  const view = data as { buffer?: ArrayBufferLike; byteOffset?: number; byteLength?: number } | null;
  if (view?.buffer) {
    return new Uint8Array(view.buffer as ArrayBuffer, view.byteOffset ?? 0, view.byteLength ?? 0).slice();
  }
  return new Uint8Array(0);
}

export class LanTransport {
  private node: MeshNode | null = null;
  private server: FrameServer | null = null;
  private sockets = new Map<string, FrameSocket>();
  private buffers = new Map<string, Uint8Array>();
  private nextId = 0;
  private localIp: string | null = null;
  private running = false;
  onStatus: (() => void) | null = null;

  async start(node: MeshNode): Promise<void> {
    if (this.running) return;
    this.node = node;
    try {
      this.localIp = await Network.getIpAddressAsync();
    } catch {
      this.localIp = null;
    }
    const server = TcpSocket.createServer((socket) => {
      this.attach(socket as unknown as FrameSocket, false);
    }) as unknown as FrameServer;
    server.on?.('error', () => {
      /* port in use or no network: LAN stays unavailable, BLE/mesh logic unaffected */
    });
    try {
      server.listen({ port: LINK_PORT, host: '0.0.0.0' });
      this.server = server;
      this.running = true;
    } catch {
      this.running = false;
    }
    this.onStatus?.();
  }

  stop(): void {
    for (const socket of this.sockets.values()) {
      try {
        socket.destroy();
      } catch {
        /* already gone */
      }
    }
    this.sockets.clear();
    this.buffers.clear();
    try {
      this.server?.close();
    } catch {
      /* ignore */
    }
    this.server = null;
    this.node = null;
    this.running = false;
    this.onStatus?.();
  }

  get started(): boolean {
    return this.running;
  }

  get ip(): string | null {
    return this.localIp;
  }

  get peerCount(): number {
    return this.sockets.size;
  }

  get port(): number {
    return LINK_PORT;
  }

  /** Scans the local /24 for other MeshLink nodes and links any that answer. */
  async scanSubnet(onProgress?: (found: number) => void): Promise<number> {
    if (!this.localIp) {
      try {
        this.localIp = await Network.getIpAddressAsync();
      } catch {
        return 0;
      }
    }
    const parts = this.localIp?.split('.') ?? [];
    if (parts.length !== 4) return 0;
    const prefix = parts.slice(0, 3).join('.');
    const me = parseInt(parts[3], 10);
    for (let wave = 0; wave < 8; wave++) {
      const hosts: Promise<boolean>[] = [];
      for (let h = wave * WAVE_SIZE + 1; h <= (wave + 1) * WAVE_SIZE; h++) {
        if (h === me || h > 254) continue;
        hosts.push(this.connectTo(`${prefix}.${h}`, SCAN_TIMEOUT_MS));
      }
      await Promise.allSettled(hosts);
      onProgress?.(this.sockets.size);
    }
    return this.sockets.size;
  }

  /** Manual connect (fallback when subnet scanning is blocked). */
  connectTo(ip: string, timeoutMs = CONNECT_TIMEOUT_MS): Promise<boolean> {
    return new Promise((resolve) => {
      let settled = false;
      const linkId = `lan-${this.nextId++}`;
      let socket: FrameSocket;
      try {
        socket = TcpSocket.createConnection({ host: ip, port: LINK_PORT }, () => {
          /* connection events drive the handshake */
        }) as unknown as FrameSocket;
      } catch {
        resolve(false);
        return;
      }
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        try {
          socket.destroy();
        } catch {
          /* ignore */
        }
        resolve(false);
      }, timeoutMs);
      socket.on('connect', () => {
        clearTimeout(timer);
        if (settled) return;
        settled = true;
        this.attach(socket, true, linkId);
        resolve(true);
      });
      socket.on('error', () => {
        clearTimeout(timer);
        if (settled) return;
        settled = true;
        resolve(false);
      });
    });
  }

  private attach(socket: FrameSocket, isInitiator: boolean, knownId?: string): void {
    if (!this.node) {
      try {
        socket.destroy();
      } catch {
        /* ignore */
      }
      return;
    }
    const linkId = knownId ?? `lan-${this.nextId++}`;
    this.sockets.set(linkId, socket);
    this.buffers.set(linkId, new Uint8Array(0));
    this.node.registerLink(
      linkId,
      'lan',
      (bytes) => {
        try {
          socket.write(lengthPrefix(bytes));
        } catch {
          /* the close handler unregisters the link */
        }
      },
      isInitiator,
    );
    socket.on('data', (data: unknown) => this.onData(linkId, toBytes(data)));
    const teardown = () => {
      if (!this.sockets.has(linkId)) return;
      this.sockets.delete(linkId);
      this.buffers.delete(linkId);
      this.node?.unregisterLink(linkId);
      this.onStatus?.();
    };
    socket.on('close', teardown);
    socket.on('error', teardown);
    this.onStatus?.();
  }

  private onData(linkId: string, chunk: Uint8Array): void {
    const previous = this.buffers.get(linkId);
    if (!previous || !this.node) return;
    const buf = previous.length === 0 ? chunk : concat(previous, chunk);
    let offset = 0;
    while (buf.length - offset >= 4) {
      const len = readLength(buf, offset);
      if (len > MAX_FRAME) {
        try {
          this.sockets.get(linkId)?.destroy();
        } catch {
          /* ignore */
        }
        this.buffers.set(linkId, new Uint8Array(0));
        return;
      }
      if (buf.length - offset - 4 < len) break;
      const frame = buf.slice(offset + 4, offset + 4 + len);
      offset += 4 + len;
      void this.node.ingest(linkId, frame);
    }
    this.buffers.set(linkId, offset === 0 ? buf : buf.slice(offset));
  }
}
