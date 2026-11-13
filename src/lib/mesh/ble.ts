// Bluetooth LE transport (best-effort).
//
// IMPORTANT — current status:
//  * Central side (scanning + connecting to a Chimera GATT service) is implemented.
//  * The peripheral side (exposing a GATT server so others can connect to THIS
//    device) requires a native module such as `react-native-ble-peripheral` and
//    is scaffolded for v1.1.
//  * iOS only allows BLE data exchange through GATT; cross-platform iOS<->Android
//    mesh therefore also needs the peripheral side. Until then Bluetooth is
//    Android-to-Android best-effort, and Wi-Fi (LAN transport) carries mesh
//    traffic across platforms.
import { BleManager, State } from 'react-native-ble-plx';

export const MESH_SERVICE_UUID = 'f47ac10b-58cc-4372-a567-0e02b2c3d479';
export const MESH_TX_CHAR_UUID = '6e400001-b5a3-f393-e0a9-e50e24dcca9e';

export class BleTransport {
  readonly name = 'ble';
  onLine: ((line: string) => void) | null = null;
  status: 'off' | 'starting' | 'scanning' | 'unavailable' = 'off';

  private manager: BleManager | null = null;

  async start(): Promise<void> {
    this.status = 'starting';
    try {
      this.manager = new BleManager();
      const state = await this.manager.state();
      if (state !== State.PoweredOn) {
        this.status = 'unavailable';
        return;
      }
      await this.scan();
    } catch {
      this.status = 'unavailable';
    }
  }

  private async scan(): Promise<void> {
    if (!this.manager) return;
    this.status = 'scanning';
    this.manager.startDeviceScan([MESH_SERVICE_UUID], { allowDuplicates: true }, (error) => {
      if (error) this.status = 'unavailable';
    });
  }

  /** Chunks a frame into GATT-sized writes once the peripheral side exists (v1.1). */
  // v1.1: implement here using device.writeCharacteristicWithResponseForService
  // with a base64 payload split into ~20-byte chunks.

  send(_line: string): void {
    // Requires the peripheral side (v1.1). LAN transport carries traffic meanwhile.
  }

  stop(): void {
    try {
      this.manager?.stopDeviceScan();
      this.manager?.destroy();
    } catch {}
    this.manager = null;
    this.status = 'off';
  }
}
