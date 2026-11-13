import { useEffect, useState } from 'react';
import { Alert, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { useRouter } from 'expo-router';
import { useLock, PASSCODE_OPERATORS, isValidPasscode } from '@/lib/lock';
import { getDisplayName, setDisplayName } from '@/lib/settings';
import { mesh } from '@/lib/mesh';

export default function SettingsScreen() {
  const router = useRouter();
  const lock = useLock();
  const [name, setName] = useState('');
  const [digits, setDigits] = useState('');
  const [opChar, setOpChar] = useState<string>('%');
  const [saved, setSaved] = useState('');

  useEffect(() => {
    void getDisplayName().then(setName);
  }, []);

  const saveName = async () => {
    if (!name.trim()) return;
    await setDisplayName(name.trim());
    await mesh.setName(name.trim());
    setSaved('Name updated.');
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
      'Erase all chats, peers, keys and your unlock code? This cannot be undone.',
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
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      <View style={styles.header}>
        <Pressable onPress={() => router.back()} style={styles.backBtn}>
          <Text style={styles.backText}>‹</Text>
        </Pressable>
        <Text style={styles.title}>Settings</Text>
      </View>

      {!!saved && <Text style={styles.saved}>{saved}</Text>}

      <Text style={styles.label}>Display name</Text>
      <View style={styles.row}>
        <TextInput style={styles.input} value={name} onChangeText={setName} maxLength={20} />
        <Pressable style={styles.btn} onPress={() => void saveName()}>
          <Text style={styles.btnText}>Save</Text>
        </Pressable>
      </View>

      <Text style={styles.label}>Change unlock code</Text>
      <Text style={styles.hint}>
        The code opens the hidden app from the calculator. Pick something you will not
        forget — it is stored only as a hash and cannot be recovered.
      </Text>
      <View style={styles.row}>
        <TextInput
          style={styles.input}
          placeholder="3–8 digits"
          placeholderTextColor="#666"
          value={digits}
          onChangeText={(t) => setDigits(t.replace(/[^0-9]/g, '').slice(0, 8))}
          keyboardType="number-pad"
          secureTextEntry
        />
        {PASSCODE_OPERATORS.map((o) => (
          <Pressable key={o} onPress={() => setOpChar(o)} style={[styles.opChip, opChar === o && styles.opChipActive]}>
            <Text style={styles.opChipText}>{o}</Text>
          </Pressable>
        ))}
      </View>
      <Pressable style={styles.btnWide} onPress={() => void changeCode()}>
        <Text style={styles.btnText}>Set new code</Text>
      </Pressable>

      <Text style={styles.label}>Danger zone</Text>
      <Pressable style={styles.danger} onPress={panicWipe}>
        <Text style={[styles.btnText, { color: '#fff' }]}>Panic wipe — erase everything</Text>
      </Pressable>

      <Text style={styles.hint}>
        Security notes: messages are end-to-end encrypted (Curve25519 via NaCl); relay
        devices cannot read them. Identity keys are first-use pinning (TOFU) — verify a
        contact in person before trusting sensitive traffic. Bluetooth mesh is
        best-effort in this build; Wi-Fi/hotspot is the primary transport.
      </Text>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#101012' },
  content: { padding: 18, paddingTop: 56, paddingBottom: 40, gap: 12 },
  header: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 8 },
  backBtn: { width: 36, height: 36, alignItems: 'center', justifyContent: 'center' },
  backText: { color: '#0a84ff', fontSize: 30, marginTop: -4 },
  title: { color: '#fff', fontSize: 22, fontWeight: '800' },
  saved: { color: '#30d158', fontSize: 13 },
  label: { color: '#8e8e93', fontSize: 12, textTransform: 'uppercase', marginTop: 8 },
  hint: { color: '#6b6b70', fontSize: 12, lineHeight: 17 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap' },
  input: {
    flex: 1,
    minWidth: 120,
    backgroundColor: '#1c1c1e',
    borderRadius: 10,
    color: '#fff',
    paddingHorizontal: 14,
    paddingVertical: 12,
    fontSize: 15,
  },
  opChip: { width: 44, height: 44, borderRadius: 22, backgroundColor: '#1c1c1e', alignItems: 'center', justifyContent: 'center' },
  opChipActive: { backgroundColor: '#ff9f0a' },
  opChipText: { color: '#fff', fontSize: 18 },
  btn: { backgroundColor: '#0a84ff', borderRadius: 10, paddingHorizontal: 20, paddingVertical: 12 },
  btnWide: { backgroundColor: '#0a84ff', borderRadius: 10, paddingVertical: 14, alignItems: 'center' },
  btnText: { color: '#fff', fontWeight: '600', fontSize: 15 },
  danger: { backgroundColor: '#ff453a', borderRadius: 10, paddingVertical: 14, alignItems: 'center' },
});
