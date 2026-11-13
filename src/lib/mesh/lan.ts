// LAN transport: peer discovery + relay over local Wi-Fi / personal hotspot.
// Every device runs a TCP server on MESH_PORT and scans its subnet for peers.
// Messages are newline-delimited JSON; relay nodes forward them with a
// decremented TTL, exactly like a store-and-forward mesh.
import TcpSocket from 'react-native-tcp-socket';
import * as Network from 'expo-network';
import { MESH_PORT } from './protocol';

// Structural types so we don't depend on the package's internal typings.
interface MeshSocket {
  on(event: string, cb: (...args: unknown[]) => void): void;
  write(data: string): void;
  destroy(): void;
}
interface MeshServer {
  listen(options: { port: number; host: string }): void;
  on?(event: string, cb: (...args: unknown[]) => void): void;
  close(): void;
}

const SCAN_TIMEOUT_MS = 400;
const WAVE_SIZE = 32;

export class LanTransport {
  readonly name = 'lan';
  onLine: ((line: string) => void) | null = null;
  started = false;
  localIp: string | null = null;

  private server: MeshServer | null = null;
  private sockets = new Map<string, MeshSocket>();
  private buffers = new Map<string, string>();
  private nextId = 0;

  async start(): Promise<void> {
    if (this.started) return;
    try {
      this.localIp = await Network.getIpAddressAsync();
    } catch {
      this.localIp = null;
    }
    const server = TcpSocket.createServer((socket) => {
      this.wire(socket);
    }) as unknown as MeshServer;
    server.listen({ port: MESH_PORT, host: '0.0.0.0' });
    server.on?.('error', (err: unknown) => {
      console.warn('[lan] server error', String(err));
    });
    this.server = server;
    this.started = true;
  }

  /** Scans the /24 subnet of the current Wi-Fi/hotspot for other Chimera nodes. */
  async scanSubnet(onProgress?: (found: number) => void): Promise<number> {
    if (!this.localIp) {
      try {
        this.localIp = await Network.getIpAddressAsync();
      } catch {
        return 0;
      }
    }
    const parts = this.localIp.split('.');
    if (parts.length !== 4) return 0;
    const prefix = parts.slice(0, 3).join('.');
    const me = parseInt(parts[3], 10);
    let found = 0;
    for (let wave = 0; wave < 8; wave++) {
      const hosts: Promise<boolean>[] = [];
      for (let h = wave * WAVE_SIZE + 1; h <= (wave + 1) * WAVE_SIZE; h++) {
        if (h === me) continue;
        hosts.push(this.connectTo(`${prefix}.${h}`, SCAN_TIMEOUT_MS));
      }
      await Promise.allSettled(hosts);
      onProgress?.(this.sockets.size);
    }
    found = this.sockets.size;
    return found;
  }

  /** Manually connect to a peer IP (fallback when subnet scanning is blocked). */  connectTo(ip: string, timeoutMs = 1500): Promise<boolean> {
    return new Promise((resolve) => {
      let settled = false;
      let socket: MeshSocket;
      try {
        socket = TcpSocket.createConnection({ host: ip, port: MESH_PORT }, () => {
          /* connected — wire() handles the rest */
        });
      } catch {
        resolve(false);
        return;
      }
      const key = `out-${this.nextId++}`;
      const timer = setTimeout(() => {
        if (!settled) {
          settled = true;
          try {
            socket.destroy();
          } catch {}
          resolve(false);
        }
      }, timeoutMs);
      socket.on('connect', () => {
        clearTimeout(timer);
        if (!settled) {
          settled = true;
          this.wire(socket, key);
          resolve(true);
        }
      });
      socket.on('error', () => {
        clearTimeout(timer);
        if (!settled) {
          settled = true;
          resolve(false);
        }
      });
    });
  }

  private wire(socket: MeshSocket, knownKey?: string): void {
    const key = knownKey ?? `in-${this.nextId++}`;
    this.buffers.set(key, '');
    this.sockets.set(key, socket);
    socket.on('data', (data: unknown) => {
      let buf = (this.buffers.get(key) ?? '') + String(data);
      let idx: number;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (line) this.onLine?.(line);
      }
      this.buffers.set(key, buf);
    });
    const teardown = () => {
      this.sockets.delete(key);
      this.buffers.delete(key);
    };
    socket.on('close', teardown);
    socket.on('error', teardown);
  }

  /** Send a framed line to every currently connected socket. */
  send(line: string): void {
    for (const socket of this.sockets.values()) {
      try {
        socket.write(line + '\n');
      } catch {
        // stale socket; its close handler will clean it up
      }
    }
  }

  /** Number of currently connected sockets. */
  get peerCount(): number {
    return this.sockets.size;
  }

  stop(): void {
    for (const socket of this.sockets.values()) {
      try {
        socket.destroy();
      } catch {}
    }
    this.sockets.clear();
    this.buffers.clear();
    try {
      this.server?.close();
    } catch {}
    this.started = false;
  }
}
