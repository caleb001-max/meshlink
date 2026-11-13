// Voice call screen. Call signaling (ringing / accept / hang up) works over the
// mesh today; the live audio streaming engine ships in v1.1 (see README).
import { useEffect, useState, useSyncExternalStore } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useRequireUnlocked } from '@/lib/lock';
import { mesh } from '@/lib/mesh';
import { subscribeMesh } from '@/lib/hooks';
import { getPeer } from '@/lib/db';
import type { CallState } from '@/lib/mesh';
import type { EnvelopeType } from '@/lib/mesh/protocol';

export default function CallScreen() {
  const ready = useRequireUnlocked();
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id: string }>();
  const peerPk = String(id ?? '');
  useSyncExternalStore(subscribeMesh, () => mesh.version);

  const [peerName, setPeerName] = useState('Unknown');
  const [state, setState] = useState<CallState>('idle');
  const [muted, setMuted] = useState(false);

  useEffect(() => {
    void getPeer(peerPk).then((p) => setPeerName(p?.name ?? 'Unknown'));
  }, [peerPk]);

  useEffect(() => {
    const off = mesh.onCall((src, type: EnvelopeType) => {
      if (src !== peerPk) return;
      if (type === 'CALL_OFFER') setState('incoming');
      else if (type === 'CALL_ANSWER') setState('active');
      else if (type === 'CALL_END') setState('ended');
    });
    return off;
  }, [peerPk]);

  if (!ready) return null;

  const call = () => {
    setState('outgoing');
    mesh.sendCallSignal(peerPk, 'CALL_OFFER');
  };
  const accept = () => {
    setState('active');
    mesh.sendCallSignal(peerPk, 'CALL_ANSWER');
  };
  const hangUp = () => {
    mesh.sendCallSignal(peerPk, 'CALL_END');
    setState('ended');
    setTimeout(() => router.back(), 800);
  };

  const statusText: Record<CallState, string> = {
    idle: 'Ready to call',
    outgoing: 'Calling…',
    incoming: 'Incoming call',
    active: 'Connected (signaling)',
    ended: 'Call ended',
  };

  return (
    <View style={styles.container}>
      <Text style={styles.hint}>
        Calls run over the device-to-device mesh (Wi-Fi/hotspot first, Bluetooth
        best-effort). This build handles call setup & hangup; live audio streaming
        lands in v1.1.
      </Text>
      <View style={styles.avatar}>
        <Text style={styles.avatarText}>{peerName.slice(0, 1).toUpperCase()}</Text>
      </View>
      <Text style={styles.name}>{peerName}</Text>
      <Text style={styles.status}>{statusText[state]}</Text>

      <View style={styles.controls}>
        {state === 'incoming' ? (
          <>
            <Pressable style={[styles.btn, styles.accept]} onPress={accept}>
              <Text style={styles.btnText}>✓</Text>
            </Pressable>
            <Pressable style={[styles.btn, styles.end]} onPress={hangUp}>
              <Text style={styles.btnText}>✕</Text>
            </Pressable>
          </>
        ) : (
          <>
            <Pressable
              style={[styles.btn, styles.secondary, muted && styles.muted]}
              onPress={() => setMuted((m) => !m)}
            >
              <Text style={styles.btnText}>{muted ? '🔇' : '🔊'}</Text>
            </Pressable>
            <Pressable style={[styles.btn, styles.end]} onPress={hangUp}>
              <Text style={styles.btnText}>✕</Text>
            </Pressable>
            {state !== 'outgoing' && state !== 'active' && (
              <Pressable style={[styles.btn, styles.accept]} onPress={call}>
                <Text style={styles.btnText}>📞</Text>
              </Pressable>
            )}
          </>
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#101012', alignItems: 'center', paddingTop: 80, gap: 16 },
  hint: {
    color: '#6b6b70',
    fontSize: 12,
    textAlign: 'center',
    paddingHorizontal: 32,
    lineHeight: 18,
  },
  avatar: {
    marginTop: 40,
    width: 120,
    height: 120,
    borderRadius: 60,
    backgroundColor: '#0a84ff',
    alignItems: 'center',
    justifyContent: 'center',
  },
  avatarText: { color: '#fff', fontSize: 48, fontWeight: '800' },
  name: { color: '#fff', fontSize: 26, fontWeight: '700' },
  status: { color: '#8e8e93', fontSize: 15 },
  controls: { flexDirection: 'row', gap: 24, marginTop: 'auto', marginBottom: 90 },
  btn: { width: 72, height: 72, borderRadius: 36, alignItems: 'center', justifyContent: 'center' },
  accept: { backgroundColor: '#30d158' },
  end: { backgroundColor: '#ff453a' },
  secondary: { backgroundColor: '#1c1c1e' },
  muted: { backgroundColor: '#3a3a3c' },
  btnText: { color: '#fff', fontSize: 26 },
});
