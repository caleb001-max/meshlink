import { useEffect, useState } from 'react';
import { Alert, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import { useRequireUnlocked } from '@/lib/lock';
import { engine } from '@/lib/engine';
import { useEngineSnapshot } from '@/lib/hooks';
import type { ContactRecord } from '@/lib/core/store';
import { ActionButton, Card, Header, Pill, Screen, SectionLabel, ui } from '@/components/ui';
import { colors, radius, space, type } from '@/lib/theme';

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : 'Action failed.';
}

function SafetyNumber({ value }: { value: string }) {
  const groups = value.split(' ');
  return (
    <View style={styles.safetyBox}>
      <Text style={styles.safetyLabel}>SAFETY NUMBER</Text>
      <Text style={styles.safetyValue}>{groups.slice(0, 3).join('  ')}</Text>
      <Text style={styles.safetyValue}>{groups.slice(3).join('  ')}</Text>
    </View>
  );
}

export default function SecurityScreen() {
  const ready = useRequireUnlocked();
  const router = useRouter();
  const snap = useEngineSnapshot();
  const [contacts, setContacts] = useState<ContactRecord[]>([]);

  useEffect(() => {
    if (!ready) return;
    void engine.start().catch(() => {});
  }, [ready]);

  useEffect(() => {
    if (!ready) return;
    void engine.contacts().then(setContacts);
  }, [ready, snap.version]);

  if (!ready) return null;

  const run = (promise: Promise<void>, failure: string) => {
    void promise.catch((err) => Alert.alert(failure, errorText(err)));
  };

  const confirmBlock = (c: ContactRecord) => {
    if (c.blocked) {
      run(engine.setBlocked(c.id, false), 'Could not unblock');
      return;
    }
    Alert.alert('Block contact', `Discard all future messages from ${c.name}?`, [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Block', style: 'destructive', onPress: () => run(engine.setBlocked(c.id, true), 'Could not block') },
    ]);
  };

  return (
    <Screen>
      <Header title="Security" subtitle="Keys, verification and trust" onBack={() => router.back()} />
      <ScrollView contentContainerStyle={styles.content}>
        <Card style={styles.summary}>
          <Text style={styles.summaryTitle}>What protects your messages</Text>
          <Text style={ui.muted}>
            Message contents are sealed with X3DH (X25519 + ML-KEM-768 hybrid) and a Double Ratchet. Transports carry
            only sealed frames. Envelopes expose rotating 8-byte tags, a coarse size bucket and a hop count — never
            names or stable identifiers.
          </Text>
          <Text style={ui.muted}>
            Relays cannot read mail. They can still see that traffic exists and which IP addresses are linked. There is
            no server, account or directory.
          </Text>
          <Text style={ui.faint}>
            Known limits: no anonymity network, no protection against a compromised device, and no live call
            encryption in this build.
          </Text>
        </Card>

        <SectionLabel>Contacts</SectionLabel>
        {contacts.length === 0 ? (
          <Card>
            <Text style={styles.emptyTitle}>No contacts yet</Text>
            <Text style={ui.muted}>Pair by QR for strong first contact, or open Nearby to answer an anonymous hello.</Text>
            <View style={styles.row}>
              <ActionButton label="Pair" onPress={() => router.push('/pair')} style={styles.flex} />
              <ActionButton label="Nearby" kind="ghost" onPress={() => router.push('/nearby')} style={styles.flex} />
            </View>
          </Card>
        ) : (
          contacts.map((c) => (
            <Card key={c.id}>
              <View style={styles.rowBetween}>
                <Text style={styles.name} numberOfLines={1}>
                  {c.name}
                </Text>
                <View style={styles.pills}>
                  {c.verified ? <Pill label="VERIFIED" tone="flame" /> : null}
                  {c.blocked ? <Pill label="BLOCKED" tone="danger" /> : null}
                  {!c.trusted && !c.blocked ? <Pill label="REQUEST" /> : null}
                </View>
              </View>

              <SafetyNumber value={c.safetyNumber} />
              <Text style={ui.faint}>
                Compare these 30 digits in person. Only then does “Mark verified” mean anything. Verification is stored
                locally and does not change with a new session.
              </Text>

              <View style={styles.row}>
                <ActionButton
                  label={c.verified ? 'Unverify' : 'Mark verified'}
                  kind={c.verified ? 'ghost' : 'flame'}
                  compact
                  onPress={() => run(engine.setVerified(c.id, !c.verified), 'Could not update verification')}
                  style={styles.flex}
                />
                <ActionButton
                  label={c.blocked ? 'Unblock' : 'Block'}
                  kind={c.blocked ? 'ghost' : 'danger'}
                  compact
                  onPress={() => confirmBlock(c)}
                  style={styles.flex}
                />
                <ActionButton
                  label="Open"
                  kind="ghost"
                  compact
                  onPress={() => router.push(`/chat/${c.id}`)}
                  style={styles.flex}
                />
              </View>
            </Card>
          ))
        )}

        <SectionLabel>Device hygiene</SectionLabel>
        <Card>
          <Text style={ui.muted}>
            The unlock code is stored only as a hash. Identities and sessions live in SecureStore and the on-device
            database. A panic wipe in Settings deletes keys, contacts, queued mail and the database.
          </Text>
          <Pressable onPress={() => router.push('/storage')}>
            <Text style={styles.linkText}>Storage details →</Text>
          </Pressable>
        </Card>
      </ScrollView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  content: { paddingBottom: space.xxl },
  flex: { flex: 1 },
  row: { flexDirection: 'row', gap: space.sm, marginTop: space.xs },
  rowBetween: { flexDirection: 'row', alignItems: 'center', gap: space.sm, justifyContent: 'space-between' },
  pills: { flexDirection: 'row', gap: 6, flexShrink: 0 },
  name: { ...type.heading, color: colors.softWhite, flexShrink: 1 },
  summary: { backgroundColor: colors.raised },
  summaryTitle: { ...type.heading, color: colors.flame, fontSize: 15 },
  safetyBox: {
    backgroundColor: colors.jetBlack,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: colors.line,
    padding: space.md,
    marginTop: space.xs,
    gap: 2,
  },
  safetyLabel: { ...type.label, color: colors.faint, fontSize: 10 },
  safetyValue: { color: colors.softWhite, fontFamily: 'monospace', fontSize: 14, letterSpacing: 1 },
  emptyTitle: { ...type.heading, color: colors.softWhite, fontSize: 15 },
  linkText: { color: colors.flame, fontWeight: '700', fontSize: 13, marginTop: space.xs },
});
