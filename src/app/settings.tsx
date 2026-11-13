import { useEffect, useState } from 'react';
import { Alert, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { useRouter } from 'expo-router';
import { useLock, useRequireUnlocked, PASSCODE_OPERATORS, isValidPasscode } from '@/lib/lock';
import { engine } from '@/lib/engine';
import { useEngineSnapshot } from '@/lib/hooks';
import { ActionButton, Card, Header, Screen, SectionLabel, ui } from '@/components/ui';
import { colors, radius, space, type } from '@/lib/theme';

export default function SettingsScreen() {
  const ready = useRequireUnlocked();
  const router = useRouter();
  const lock = useLock();
  const snap = useEngineSnapshot();
  const [nameDraft, setNameDraft] = useState<string | null>(null);
  const [digits, setDigits] = useState('');
  const [opChar, setOpChar] = useState<string>('%');
  const [saved, setSaved] = useState('');

  useEffect(() => {
    if (!ready) return;
    void engine.start().catch(() => {});
  }, [ready]);

  if (!ready) return null;

  const name = nameDraft ?? (snap.displayName === 'Anonymous' ? '' : snap.displayName);

  const saveName = async () => {
    const clean = name.trim();
    if (!clean) return;
    try {
      await engine.setName(clean);
      setSaved('Display name updated. Your next hello carries it to paired contacts.');
    } catch (err) {
      Alert.alert('Could not save', err instanceof Error ? err.message : 'Unknown error');
    }
  };

  const changeCode = async () => {
    const code = `${digits}${opChar}`;
    if (!isValidPasscode(code)) {
      Alert.alert('Invalid code', 'Use 3–8 digits followed by an operator.');
      return;
    }
    await lock.setCode(name.trim() || 'Anonymous', code);
    setDigits('');
    setSaved('Unlock code changed. Remember it — nothing can recover it.');
  };

  const panicWipe = () => {
    Alert.alert(
      'Panic wipe',
      'Erase all chats, contacts, keys, queued mail and your unlock code? This cannot be undone.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Wipe everything',
          style: 'destructive',
          onPress: () => {
            void lock.wipe().then(() => router.replace('/'));
          },
        },
      ],
    );
  };

  return (
    <Screen>
      <Header title="Settings" subtitle="Identity, unlock code, data" onBack={() => router.back()} />
      <ScrollView contentContainerStyle={styles.content}>
        {!!saved && <Text style={styles.saved}>{saved}</Text>}

        <SectionLabel>Profile</SectionLabel>
        <Card>
          <Text style={styles.label}>Display name</Text>
          <Text style={ui.faint}>Shared with paired contacts in sealed messages. Never broadcast in the clear.</Text>
          <View style={styles.row}>
            <TextInput
              style={styles.input}
              value={name}
              onChangeText={setNameDraft}
              maxLength={24}
              placeholder="Anonymous"
              placeholderTextColor={colors.faint}
            />
            <ActionButton label="Save" compact onPress={() => void saveName()} disabled={!name.trim()} />
          </View>
        </Card>

        <SectionLabel>Unlock code</SectionLabel>
        <Card>
          <Text style={styles.label}>Change code</Text>
          <Text style={ui.faint}>
            Opens the hidden app from the calculator. Stored only as a hash; there is no recovery.
          </Text>
          <View style={styles.row}>
            <TextInput
              style={styles.input}
              placeholder="3–8 digits"
              placeholderTextColor={colors.faint}
              value={digits}
              onChangeText={(t) => setDigits(t.replace(/[^0-9]/g, '').slice(0, 8))}
              keyboardType="number-pad"
              secureTextEntry
            />
            {PASSCODE_OPERATORS.map((o) => (
              <Pressable
                key={o}
                onPress={() => setOpChar(o)}
                style={[styles.opChip, opChar === o && styles.opChipActive]}
                accessibilityLabel={`Operator ${o}`}
              >
                <Text style={[styles.opChipText, opChar === o && styles.opChipTextActive]}>{o}</Text>
              </Pressable>
            ))}
          </View>
          <ActionButton label="Set new code" onPress={() => void changeCode()} disabled={digits.length < 3} />
        </Card>

        <SectionLabel>MeshLink</SectionLabel>
        <Card style={styles.navCard}>
          <NavRow label="Pair a contact" detail="QR, out of band" onPress={() => router.push('/pair')} />
          <NavRow label="Nearby" detail="Same Wi-Fi, anonymous hellos" onPress={() => router.push('/nearby')} />
          <NavRow label="Network" detail="Links, relay consent, SOS, events" onPress={() => router.push('/network')} />
          <NavRow label="Security" detail="Safety numbers and verification" onPress={() => router.push('/security')} />
          <NavRow label="Storage" detail="Local database and identity" onPress={() => router.push('/storage')} />
        </Card>

        <SectionLabel>Danger zone</SectionLabel>
        <Card style={styles.dangerCard}>
          <Text style={ui.muted}>
            Panic wipe deletes the identity, sessions, contacts, messages, relay queue and the database, then resets the
            calculator. There is no backup.
          </Text>
          <ActionButton label="Panic wipe — erase everything" kind="danger" onPress={panicWipe} />
        </Card>

        <Text style={styles.footnote}>
          Build honesty: Wi-Fi/hotspot transport is wired to the tested MeshLink v2 node. Bluetooth, live calls and
          multi-device hardware tests are not claimed as working. See docs/STATUS.md in the project.
        </Text>
      </ScrollView>
    </Screen>
  );
}

function NavRow({ label, detail, onPress }: { label: string; detail: string; onPress: () => void }) {
  return (
    <Pressable onPress={onPress} style={styles.navRow} accessibilityRole="button">
      <View style={styles.flex}>
        <Text style={styles.navLabel}>{label}</Text>
        <Text style={ui.faint}>{detail}</Text>
      </View>
      <Text style={styles.chevron}>›</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  content: { paddingBottom: space.xxl },
  flex: { flex: 1 },
  saved: { color: colors.flame, fontSize: 13, marginHorizontal: space.lg, marginTop: space.sm },
  label: { ...type.heading, color: colors.softWhite, fontSize: 15 },
  row: { flexDirection: 'row', alignItems: 'center', gap: space.sm, flexWrap: 'wrap', marginTop: space.xs },
  input: {
    flex: 1,
    minWidth: 130,
    backgroundColor: colors.jetBlack,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: colors.line,
    color: colors.softWhite,
    paddingHorizontal: space.md,
    paddingVertical: 12,
    fontSize: 15,
  },
  opChip: {
    width: 44,
    height: 44,
    borderRadius: radius.sm,
    backgroundColor: colors.jetBlack,
    borderWidth: 1,
    borderColor: colors.line,
    alignItems: 'center',
    justifyContent: 'center',
  },
  opChipActive: { backgroundColor: colors.flame, borderColor: colors.flame },
  opChipText: { color: colors.softWhite, fontSize: 18 },
  opChipTextActive: { color: colors.jetBlack, fontWeight: '800' },
  navCard: { gap: 0, paddingVertical: space.xs },
  navRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    paddingVertical: space.md,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.line,
  },
  navLabel: { color: colors.softWhite, fontSize: 15, fontWeight: '600' },
  chevron: { color: colors.faint, fontSize: 22, marginTop: -2 },
  dangerCard: { borderColor: 'rgba(255,59,48,0.35)' },
  footnote: { color: colors.faint, fontSize: 11, lineHeight: 17, paddingHorizontal: space.xl, marginTop: space.md },
});
