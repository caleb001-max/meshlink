import { useEffect, useState } from 'react';
import { Alert, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { useRouter } from 'expo-router';
import { useRequireUnlocked } from '@/lib/lock';
import { engine } from '@/lib/engine';
import { useEngineSnapshot } from '@/lib/hooks';
import { ActionButton, Card, Header, Pill, Screen, SectionLabel, ui } from '@/components/ui';
import { colors, radius, space, type } from '@/lib/theme';

export default function NearbyScreen() {
  const ready = useRequireUnlocked();
  const router = useRouter();
  const snap = useEngineSnapshot();
  const [manualIp, setManualIp] = useState('');
  const [scanning, setScanning] = useState(false);
  const [sending, setSending] = useState<string | null>(null);

  useEffect(() => {
    if (!ready) return;
    void engine.start().catch(() => {});
  }, [ready]);

  if (!ready) return null;

  const tags = engine.nearbyTags();

  const scan = async () => {
    setScanning(true);
    try {
      const found = await engine.scanLan();
      Alert.alert(
        'Scan complete',
        found > 0
          ? `${found} link(s) open. Anonymous devices appear below after their next hello.`
          : 'No devices answered. Both phones must be on the same Wi-Fi or hotspot.',
      );
    } catch {
      Alert.alert('Scan failed', 'Wi-Fi must be on for LAN discovery. Bluetooth is not active in this build.');
    } finally {
      setScanning(false);
    }
  };

  const connectManual = async () => {
    const ip = manualIp.trim();
    if (!ip) return;
    const ok = await engine.linkTo(ip);
    if (ok) {
      setManualIp('');
      await engine.announce();
      Alert.alert('Link opened', `Secure link established with ${ip}.`);
    } else {
      Alert.alert('No response', `Nothing answered on port ${snap.lan.port} at ${ip}.`);
    }
  };

  const sayHello = async (tag: string) => {
    setSending(tag);
    try {
      await engine.sendIntro(tag, 'Hello from MeshLink');
      Alert.alert(
        'Hello queued',
        'Sealed for that nearby device. If they accept, a message request appears in Chats. This is not a live chat session yet.',
      );
    } catch (err) {
      Alert.alert('Hello not sent', err instanceof Error ? err.message : 'The device may be out of range.');
    } finally {
      setSending(null);
    }
  };

  return (
    <Screen>
      <Header title="Nearby" subtitle="Same network, no directory" onBack={() => router.back()} />
      <ScrollView contentContainerStyle={styles.content}>
        <Card>
          <View style={styles.statusRow}>
            <Text style={styles.cardTitle}>Wi-Fi / hotspot</Text>
            <Pill label={snap.lan.running ? 'LISTENING' : 'OFF'} tone={snap.lan.running ? 'flame' : 'neutral'} />
          </View>
          <Text style={ui.muted}>
            {snap.lan.running
              ? `${snap.lan.ip ?? 'No address yet'} · port ${snap.lan.port} · ${snap.lan.peers} socket(s)`
              : 'LAN listener is off. Turn on Wi-Fi and unlock the app.'}
          </Text>
          <View style={styles.row}>
            <ActionButton
              label={scanning ? 'Scanning…' : 'Scan local network'}
              onPress={() => void scan()}
              disabled={scanning}
              style={styles.flex}
            />
            <ActionButton label="Pair by QR" kind="ghost" onPress={() => router.push('/pair')} style={styles.flex} />
          </View>
        </Card>

        <Card style={styles.honestCard}>
          <Text style={styles.cardTitle}>Bluetooth</Text>
          <Text style={ui.muted}>
            Not active in this build. Advertised Bluetooth range and battery claims do not apply until the peripheral
            path is verified on hardware. Wi-Fi/hotspot is the working transport.
          </Text>
        </Card>

        <SectionLabel>Anonymous devices</SectionLabel>
        <Card>
          {tags.length === 0 ? (
            <Text style={ui.muted}>
              No hellos observed. Run a scan, keep both devices on the same network, and wait for the next announce.
            </Text>
          ) : (
            tags.map((tag) => (
              <View key={tag} style={styles.tagRow}>
                <View style={styles.flex}>
                  <Text style={styles.tag}>tag {tag.slice(0, 8)}…</Text>
                  <Text style={ui.faint}>Rotating address · name not broadcast</Text>
                </View>
                <ActionButton
                  label={sending === tag ? 'Sending…' : 'Say hello'}
                  compact
                  onPress={() => void sayHello(tag)}
                  disabled={sending !== null}
                />
              </View>
            ))
          )}
        </Card>

        <SectionLabel>Manual link</SectionLabel>
        <Card>
          <View style={styles.row}>
            <TextInput
              style={styles.input}
              placeholder="192.168.43.22"
              placeholderTextColor={colors.faint}
              value={manualIp}
              onChangeText={setManualIp}
              autoCapitalize="none"
              keyboardType="numbers-and-punctuation"
            />
            <ActionButton label="Link" compact onPress={() => void connectManual()} />
          </View>
          <Text style={ui.faint}>Fallback when the access point blocks subnet scanning.</Text>
        </Card>

        <Pressable onPress={() => router.push('/network')} style={styles.linkOut}>
          <Text style={styles.linkOutText}>Open the full network view →</Text>
        </Pressable>
      </ScrollView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  content: { paddingBottom: space.xxl },
  flex: { flex: 1 },
  row: { flexDirection: 'row', alignItems: 'center', gap: space.sm, marginTop: space.xs },
  statusRow: { flexDirection: 'row', alignItems: 'center', gap: space.md, justifyContent: 'space-between' },
  cardTitle: { ...type.heading, color: colors.softWhite, fontSize: 15 },
  honestCard: { backgroundColor: colors.raised },
  tagRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    paddingVertical: space.sm,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.line,
  },
  tag: { color: colors.softWhite, fontFamily: 'monospace', fontSize: 13 },
  input: {
    flex: 1,
    backgroundColor: colors.jetBlack,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: colors.line,
    color: colors.softWhite,
    paddingHorizontal: space.md,
    paddingVertical: 11,
    fontSize: 14,
  },
  linkOut: { paddingHorizontal: space.xl, paddingTop: space.md },
  linkOutText: { color: colors.flame, fontWeight: '700', fontSize: 13 },
});
