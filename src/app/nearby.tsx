// Mesh status + peer discovery. Shows LAN/Bluetooth status, scans the local
// subnet for other Chimera nodes, and allows manual IP connection.
import { useEffect, useState } from 'react';
import { Alert, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { useRouter } from 'expo-router';
import { useSyncExternalStore } from 'react';
import { useRequireUnlocked } from '@/lib/lock';
import { mesh } from '@/lib/mesh';
import { subscribeMesh } from '@/lib/hooks';
import { listPeers, type Peer } from '@/lib/db';

export default function NearbyScreen() {
  const ready = useRequireUnlocked();
  const router = useRouter();
  useSyncExternalStore(subscribeMesh, () => mesh.version);

  const snap = mesh.getSnapshot();
  const [peers, setPeers] = useState<Peer[]>([]);
  const [manualIp, setManualIp] = useState('');
  const [scanning, setScanning] = useState(false);

  useEffect(() => {
    void listPeers().then(setPeers);
  }, [mesh.version]);

  if (!ready) return null;

  const scan = async () => {
    setScanning(true);
    try {
      const found = await mesh.lan.scanSubnet();
      await mesh.sendHello();
      Alert.alert('Scan complete', `${found} device(s) found on your local network.`);
    } catch {
      Alert.alert('Scan failed', 'Connect to Wi-Fi or a personal hotspot first.');
    } finally {
      setScanning(false);
    }
  };

  const connectManual = async () => {
    const ip = manualIp.trim();
    if (!ip) return;
    const ok = await mesh.lan.connectTo(ip);
    if (ok) {
      await mesh.sendHello();
      Alert.alert('Connected', `Linked with ${ip}.`);
      setManualIp('');
    } else {
      Alert.alert('No response', `Nothing answered on port ${snap.port} at ${ip}.`);
    }
  };

  const bleLabel: Record<string, string> = {
    off: 'off',
    starting: 'starting…',
    scanning: 'scanning',
    unavailable: 'unavailable',
  };

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <Pressable onPress={() => router.back()} style={styles.backBtn}>
          <Text style={styles.backText}>‹</Text>
        </Pressable>
        <Text style={styles.title}>Nearby mesh</Text>
      </View>

      <View style={styles.card}>
        <Text style={styles.cardTitle}>Transports</Text>
        <Text style={styles.line}>
          Wi-Fi/LAN: {snap.started ? `running on ${snap.ip ?? 'no network'} :${snap.port}` : 'stopped'} —{' '}
          {snap.lanPeers} direct link(s)
        </Text>
        <Text style={styles.line}>Bluetooth LE: {bleLabel[snap.ble] ?? snap.ble}</Text>
        <Text style={styles.hint}>
          Both phones must be on the same Wi-Fi, or one can share a hotspot. Messages
          hop through other Chimera devices (TTL relay) until they reach the target.
        </Text>
      </View>

      <View style={styles.rowBtns}>
        <Pressable style={styles.actionBtn} onPress={() => void scan()} disabled={scanning}>
          <Text style={styles.actionText}>{scanning ? 'Scanning…' : 'Scan local network'}</Text>
        </Pressable>
        <Pressable
          style={styles.actionBtn}
          onPress={() => {
            void mesh.sendHello();
            Alert.alert('Beacon sent', 'Your discovery beacon was broadcast to all links.');
          }}
        >
          <Text style={styles.actionText}>Re-announce</Text>
        </Pressable>
      </View>

      <View style={styles.card}>
        <Text style={styles.cardTitle}>Manual link</Text>
        <View style={styles.manualRow}>
          <TextInput
            style={styles.input}
            placeholder="e.g. 192.168.43.22"
            placeholderTextColor="#666"
            value={manualIp}
            onChangeText={setManualIp}
            autoCapitalize="none"
            keyboardType="numbers-and-punctuation"
          />
          <Pressable style={styles.linkBtn} onPress={() => void connectManual()}>
            <Text style={styles.actionText}>Link</Text>
          </Pressable>
        </View>
      </View>

      <Text style={styles.sectionTitle}>Discovered people</Text>
      <ScrollView contentContainerStyle={styles.peersWrap}>
        {peers.length === 0 && <Text style={styles.hint}>No peers discovered yet.</Text>}
        {peers.map((p) => (
          <Pressable key={p.pk} style={styles.peerRow} onPress={() => router.push(`/chat/${p.pk}`)}>
            <View style={styles.avatar}>
              <Text style={styles.avatarText}>{(p.name || '?').slice(0, 1).toUpperCase()}</Text>
            </View>
            <View style={{ flex: 1 }}>
              <Text style={styles.peerName}>{p.name}</Text>
              <Text style={styles.peerSub}>
                {p.pk.slice(0, 12)}… · last seen {new Date(p.lastSeen).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
              </Text>
            </View>
          </Pressable>
        ))}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#101012', paddingTop: 56 },
  header: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 14, paddingBottom: 12 },
  backBtn: { width: 36, height: 36, alignItems: 'center', justifyContent: 'center' },
  backText: { color: '#0a84ff', fontSize: 30, marginTop: -4 },
  title: { color: '#fff', fontSize: 22, fontWeight: '800' },
  card: {
    backgroundColor: '#18181b',
    borderRadius: 14,
    padding: 14,
    marginHorizontal: 14,
    marginBottom: 12,
    gap: 6,
  },
  cardTitle: { color: '#fff', fontWeight: '700', fontSize: 15 },
  line: { color: '#c7c7cc', fontSize: 13 },
  hint: { color: '#6b6b70', fontSize: 12, lineHeight: 17 },
  rowBtns: { flexDirection: 'row', gap: 10, paddingHorizontal: 14, marginBottom: 12 },
  actionBtn: { flex: 1, backgroundColor: '#0a84ff', borderRadius: 10, paddingVertical: 12, alignItems: 'center' },
  actionText: { color: '#fff', fontWeight: '600', fontSize: 14 },
  manualRow: { flexDirection: 'row', gap: 8 },
  input: {
    flex: 1,
    backgroundColor: '#101012',
    borderRadius: 10,
    color: '#fff',
    paddingHorizontal: 12,
    fontSize: 14,
  },
  linkBtn: { backgroundColor: '#1c1c1e', borderRadius: 10, paddingHorizontal: 18, justifyContent: 'center' },
  sectionTitle: { color: '#8e8e93', fontSize: 12, paddingHorizontal: 18, marginBottom: 6, textTransform: 'uppercase' },
  peersWrap: { paddingHorizontal: 14, paddingBottom: 30 },
  peerRow: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 8 },
  avatar: { width: 44, height: 44, borderRadius: 22, backgroundColor: '#0a84ff', alignItems: 'center', justifyContent: 'center' },
  avatarText: { color: '#fff', fontSize: 18, fontWeight: '700' },
  peerName: { color: '#fff', fontSize: 15, fontWeight: '600' },
  peerSub: { color: '#6b6b70', fontSize: 11 },
});
