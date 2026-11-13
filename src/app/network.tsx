import { useEffect, useState } from 'react';
import { Alert, Pressable, ScrollView, StyleSheet, Switch, Text, TextInput, View } from 'react-native';
import { useRouter } from 'expo-router';
import { useRequireUnlocked } from '@/lib/lock';
import { engine } from '@/lib/engine';
import { useEngineSnapshot } from '@/lib/hooks';
import type { NetworkEventRecord } from '@/lib/core/store';
import { ActionButton, Card, Header, Pill, Screen, SectionLabel, ui } from '@/components/ui';
import { colors, radius, space, type } from '@/lib/theme';

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function eventTime(ts: number): string {
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

export default function NetworkScreen() {
  const ready = useRequireUnlocked();
  const router = useRouter();
  const snap = useEngineSnapshot();
  const [events, setEvents] = useState<NetworkEventRecord[]>([]);
  const [manualIp, setManualIp] = useState('');
  const [scanning, setScanning] = useState(false);
  const [sosBusy, setSosBusy] = useState(false);

  useEffect(() => {
    if (!ready) return;
    void engine.start().catch(() => {});
  }, [ready]);

  useEffect(() => {
    if (!ready) return;
    void engine.events(40).then(setEvents);
  }, [ready, snap.version]);

  if (!ready) return null;

  const scan = async () => {
    setScanning(true);
    try {
      const found = await engine.scanLan();
      Alert.alert(
        'Scan complete',
        `${found} direct link(s) on this network. Devices on other Wi-Fi networks are not reachable — MeshLink has no internet path.`,
      );
    } catch {
      Alert.alert('Scan failed', 'Connect both phones to the same Wi-Fi or personal hotspot first.');
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

  const confirmSos = () => {
    Alert.alert(
      'Send SOS',
      'This queues an urgent message to trusted contacts and every nearby device. It is still store-and-forward — it cannot call emergency services and may wait for a route.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Send SOS',
          style: 'destructive',
          onPress: () => {
            setSosBusy(true);
            void engine
              .sendSos('SOS — I need help.')
              .then((count) =>
                Alert.alert(
                  'SOS queued',
                  count > 0
                    ? `Sealed for ${count} recipient(s). They receive it as soon as a route exists.`
                    : 'No trusted contacts and no nearby devices right now. Nothing was sent.',
                ),
              )
              .catch((err) => Alert.alert('SOS failed', err instanceof Error ? err.message : 'Unknown error'))
              .finally(() => setSosBusy(false));
          },
        },
      ],
    );
  };

  const lanReady = snap.lan.running;
  const securedLinks = snap.links.filter((l) => l.secured).length;

  return (
    <Screen>
      <Header title="Network" subtitle="What this device can actually reach" onBack={() => router.back()} />
      <ScrollView contentContainerStyle={styles.content}>
        <Card>
          <View style={styles.statusRow}>
            <Text style={styles.cardTitle}>Wi-Fi / hotspot</Text>
            <Pill label={lanReady ? 'LISTENING' : 'OFF'} tone={lanReady ? 'flame' : 'neutral'} />
          </View>
          <Text style={ui.muted}>
            {lanReady
              ? `${snap.lan.ip ?? 'No address yet'} · port ${snap.lan.port} · ${snap.lan.peers} socket(s)`
              : 'The LAN listener is not running. Check that Wi-Fi is on and the app is unlocked.'}
          </Text>
          <Text style={ui.faint}>
            Direct links: {snap.links.length} · secured: {securedLinks}. Links carry sealed frames only; the transport
            itself never sees message contents.
          </Text>
        </Card>

        <Card style={styles.honestCard}>
          <Text style={styles.cardTitle}>Bluetooth</Text>
          <Text style={ui.muted}>
            Not active in this build. The bundled peripheral module is scaffolded but not verified on hardware, so
            MeshLink does not advertise Bluetooth as a working transport. Wi-Fi/hotspot carries traffic today.
          </Text>
        </Card>

        <SectionLabel>Relay</SectionLabel>
        <Card>
          <View style={styles.statusRow}>
            <View style={styles.flex}>
              <Text style={styles.cardTitle}>Forward mail for others</Text>
              <Text style={ui.muted}>
                Off by default. When on, this device stores sealed envelopes briefly and forwards them for other
                people. It never has their keys, so it cannot read them — but relaying spends battery and data.
              </Text>
            </View>
            <Switch
              value={snap.relayEnabled}
              onValueChange={(v) => void engine.setRelayEnabled(v)}
              trackColor={{ false: colors.line, true: 'rgba(255,90,31,0.45)' }}
              thumbColor={snap.relayEnabled ? colors.flame : colors.muted}
            />
          </View>
          <Text style={ui.faint}>
            Queue held by this device: {snap.queueSize} envelope(s), {formatBytes(snap.queueBytes)}.
          </Text>
        </Card>

        <SectionLabel>Discover</SectionLabel>
        <Card>
          <View style={styles.row}>
            <ActionButton label={scanning ? 'Scanning…' : 'Scan local network'} onPress={() => void scan()} disabled={scanning} style={styles.flex} />
            <ActionButton label="Re-announce" kind="ghost" onPress={() => void engine.announce()} style={styles.flex} />
          </View>
          <Text style={ui.faint}>Scanning walks this /24 only. It does not probe the internet or other subnets.</Text>
        </Card>

        <Card>
          <Text style={styles.cardTitle}>Manual link</Text>
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
          <Text style={ui.faint}>Use when subnet scanning is blocked by the access point.</Text>
        </Card>

        <SectionLabel>Links</SectionLabel>
        <Card>
          {snap.links.length === 0 ? (
            <Text style={ui.muted}>No open links. Same-Wi-Fi devices appear here after a scan or manual link.</Text>
          ) : (
            snap.links.map((l) => (
              <View key={l.id} style={styles.linkRow}>
                <View style={styles.flex}>
                  <Text style={styles.linkTitle}>{l.transport.toUpperCase()}</Text>
                  <Text style={ui.faint}>
                    {l.secured ? `sealed · peer ${l.peerTag ?? '—'}` : 'handshaking…'} · open{' '}
                    {new Date(l.establishedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                  </Text>
                </View>
                <Pill label={l.secured ? 'SEALED' : 'HS'} tone={l.secured ? 'flame' : 'neutral'} />
              </View>
            ))
          )}
        </Card>

        <SectionLabel>Emergency</SectionLabel>
        <Card style={styles.sosCard}>
          <Text style={styles.cardTitle}>SOS</Text>
          <Text style={ui.muted}>
            Highest priority, shortest lifetime, more relay copies. Goes to trusted contacts and nearby devices. It is
            not a substitute for a phone call to emergency services.
          </Text>
          <ActionButton label={sosBusy ? 'Queueing…' : 'Send SOS'} kind="danger" onPress={confirmSos} disabled={sosBusy} />
        </Card>

        <SectionLabel>Event log</SectionLabel>
        <Card>
          {events.length === 0 ? (
            <Text style={ui.muted}>Nothing observed yet. Link, relay and security events appear here.</Text>
          ) : (
            events
              .slice()
              .reverse()
              .map((e, i) => (
                <View key={`${e.ts}-${i}`} style={styles.eventRow}>
                  <Text style={styles.eventKind}>{e.kind}</Text>
                  <Text style={styles.eventDetail} numberOfLines={3}>
                    {e.detail}
                  </Text>
                  <Text style={ui.faint}>{eventTime(e.ts)}</Text>
                </View>
              ))
          )}
          <ActionButton
            label="Clear event log"
            kind="ghost"
            compact
            onPress={() => void engine.clearEvents()}
            disabled={events.length === 0}
          />
        </Card>

        <Pressable onPress={() => router.push('/storage')} style={styles.linkOut}>
          <Text style={styles.linkOutText}>Storage and on-device data →</Text>
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
  honestCard: { borderColor: colors.line, backgroundColor: colors.raised },
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
  linkRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    paddingVertical: space.sm,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.line,
  },
  linkTitle: { color: colors.softWhite, fontWeight: '700', fontSize: 13, letterSpacing: 0.5 },
  sosCard: { borderColor: 'rgba(255,59,48,0.35)' },
  eventRow: { gap: 2, paddingVertical: space.sm, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.line },
  eventKind: { color: colors.flame, fontSize: 10, fontWeight: '800', letterSpacing: 1, textTransform: 'uppercase' },
  eventDetail: { color: colors.muted, fontSize: 12, lineHeight: 17 },
  linkOut: { paddingHorizontal: space.xl, paddingTop: space.md },
  linkOutText: { color: colors.flame, fontWeight: '700', fontSize: 13 },
});
