import { useEffect, useState } from 'react';
import { Alert, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import { useRequireUnlocked } from '@/lib/lock';
import { engine } from '@/lib/engine';
import { useEngineSnapshot } from '@/lib/hooks';
import type { StoreStats } from '@/lib/engine/sqlite-store';
import { ActionButton, Card, Header, Screen, SectionLabel, ui } from '@/components/ui';
import { colors, radius, space, type } from '@/lib/theme';

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MB`;
}

function shortId(id: string | null): string {
  if (!id) return 'not available';
  return `${id.slice(0, 16)}…${id.slice(-8)}`;
}

export default function StorageScreen() {
  const ready = useRequireUnlocked();
  const router = useRouter();
  const snap = useEngineSnapshot();
  const [stats, setStats] = useState<StoreStats | null>(null);

  useEffect(() => {
    if (!ready) return;
    void engine.start().catch(() => {});
  }, [ready]);

  useEffect(() => {
    if (!ready) return;
    void engine.stats().then(setStats);
  }, [ready, snap.version]);

  if (!ready) return null;

  const rows: { label: string; value: string }[] = [
    { label: 'Contacts', value: String(stats?.contacts ?? snap.contacts) },
    { label: 'Messages', value: String(stats?.messages ?? 0) },
    { label: 'Queued envelopes', value: String(stats?.queued ?? snap.queueSize) },
    { label: 'Queue bytes', value: formatBytes(snap.queueBytes) },
    { label: 'Log events', value: String(stats?.events ?? 0) },
    { label: 'Database size', value: formatBytes(stats?.bytes ?? 0) },
  ];

  return (
    <Screen>
      <Header title="Storage" subtitle="What lives on this device" onBack={() => router.back()} />
      <ScrollView contentContainerStyle={styles.content}>
        <Card>
          <Text style={styles.cardTitle}>Local database</Text>
          {rows.map((r) => (
            <View key={r.label} style={styles.statRow}>
              <Text style={styles.statLabel}>{r.label}</Text>
              <Text style={styles.statValue}>{r.value}</Text>
            </View>
          ))}
          <Text style={ui.faint}>
            One SQLite file (`meshlink.db`), no cloud sync, no backup service. WAL mode keeps writes durable between
            sends.
          </Text>
        </Card>

        <SectionLabel>Identity</SectionLabel>
        <Card>
          <Text style={styles.cardTitle}>Public identity of this device</Text>
          <Text style={styles.mono}>{shortId(snap.myId)}</Text>
          <Text style={ui.faint}>
            The full Ed25519 public key is what contacts store. The private half is kept in SecureStore. Losing the
            device without a backup means contacts must pair again — there is no recovery service.
          </Text>
        </Card>

        <SectionLabel>Maintenance</SectionLabel>
        <Card>
          <Text style={styles.cardTitle}>Event log</Text>
          <Text style={ui.muted}>
            Link, relay and security events are capped at the newest 2,000 rows. Clearing them does not touch messages
            or contacts.
          </Text>
          <ActionButton
            label="Clear event log"
            kind="ghost"
            compact
            disabled={(stats?.events ?? 0) === 0}
            onPress={() => {
              void engine
                .clearEvents()
                .then(() => engine.stats().then(setStats))
                .catch((err) => Alert.alert('Could not clear log', err instanceof Error ? err.message : 'Unknown error'));
            }}
          />
        </Card>

        <Card style={styles.dangerCard}>
          <Text style={styles.cardTitle}>Erase everything</Text>
          <Text style={ui.muted}>
            Panic wipe removes the identity, sessions, contacts, queued mail and the encryption database, then clears
            your unlock code. It cannot be undone.
          </Text>
          <ActionButton label="Go to danger zone" kind="danger" onPress={() => router.push('/settings')} />
        </Card>
      </ScrollView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  content: { paddingBottom: space.xxl },
  cardTitle: { ...type.heading, color: colors.softWhite, fontSize: 15 },
  statRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: space.sm,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.line,
  },
  statLabel: { color: colors.muted, fontSize: 13 },
  statValue: { color: colors.softWhite, fontSize: 14, fontWeight: '700', fontVariant: ['tabular-nums'] },
  mono: {
    color: colors.softWhite,
    fontFamily: 'monospace',
    fontSize: 12,
    backgroundColor: colors.jetBlack,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: colors.line,
    padding: space.md,
  },
  dangerCard: { borderColor: 'rgba(255,59,48,0.35)' },
});
