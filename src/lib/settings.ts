// App settings (display name, unlock code hash) stored in the encrypted-backed
// SQLite key-value store. The unlock code itself is never stored — only a hash.
import Storage from 'expo-sqlite/kv-store';

export async function getDisplayName(): Promise<string> {
  return (await Storage.getItem('displayName')) ?? 'Anonymous';
}

export async function setDisplayName(name: string): Promise<void> {
  await Storage.setItem('displayName', name);
}

export async function getPasscodeHash(): Promise<string | null> {
  return (await Storage.getItem('passcodeHash')) ?? null;
}

export async function setPasscodeHash(hash: string): Promise<void> {
  await Storage.setItem('passcodeHash', hash);
}

export async function wipeSettings(): Promise<void> {
  await Storage.removeItem('displayName');
  await Storage.removeItem('passcodeHash');
}
