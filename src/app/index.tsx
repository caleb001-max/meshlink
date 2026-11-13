// Calculator screen — the disguise. It is a fully working calculator. Typing the
// user's custom code (digits followed by an operator, e.g. 1337%) silently opens
// the hidden app. First run shows onboarding to pick the name + custom code.
import { useCallback, useMemo, useState } from 'react';
import {
  KeyboardAvoidingView,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useRouter } from 'expo-router';
import { useLock, PASSCODE_OPERATORS, isValidPasscode } from '@/lib/lock';

const MAX_ENTRY = 12;

function apply(a: number, op: string, b: number): number {
  switch (op) {
    case '÷':
      return b === 0 ? NaN : a / b;
    case '×':
      return a * b;
    case '−':
      return a - b;
    case '+':
      return a + b;
    case '%':
      return b === 0 ? NaN : a % b;
    default:
      return b;
  }
}

function fmt(n: number): string {
  if (Number.isNaN(n)) return 'Error';
  const s = String(Math.round(n * 1e10) / 1e10);
  return s.length > MAX_ENTRY + 3 ? n.toExponential(6) : s;
}

const ROWS: string[][] = [
  ['AC', '⌫', '%', '÷'],
  ['7', '8', '9', '×'],
  ['4', '5', '6', '−'],
  ['1', '2', '3', '+'],
  ['0', '.', '='],
];

const OP_KEYS = new Set(['÷', '×', '−', '+', '%']);

export default function CalculatorScreen() {
  const router = useRouter();
  const lock = useLock();

  const [entry, setEntry] = useState('');
  const [acc, setAcc] = useState<number | null>(null);
  const [op, setOp] = useState<string | null>(null);
  const [display, setDisplay] = useState('0');

  const tryUnlock = useCallback(
    (candidate: string) => {
      if (!lock.hasCode || !candidate) return;
      void lock.verify(candidate).then((ok) => {
        if (ok) router.replace('/chats');
      });
    },
    [lock, router],
  );

  const press = useCallback(
    (key: string) => {
      if (key === 'AC') {
        setEntry('');
        setAcc(null);
        setOp(null);
        setDisplay('0');
        return;
      }
      if (key === '⌫') {
        setEntry((e) => e.slice(0, -1));
        setDisplay((d) => (d.length > 1 ? d.slice(0, -1) : '0'));
        return;
      }
      if (OP_KEYS.has(key)) {
        tryUnlock(entry + key);
        if (entry === '' && acc === null) return;
        let nextAcc: number;
        if (acc === null) nextAcc = parseFloat(entry) || 0;
        else if (entry === '') nextAcc = acc;
        else nextAcc = apply(acc, op ?? '+', parseFloat(entry));
        setAcc(nextAcc);
        setOp(key);
        setEntry('');
        setDisplay(fmt(nextAcc));
        return;
      }
      if (key === '=') {
        tryUnlock(entry + '=');
        if (op !== null) {
          const b = parseFloat(entry || '0');
          const result = apply(acc ?? 0, op, b);
          const s = fmt(result);
          setAcc(null);
          setOp(null);
          setEntry(Number.isNaN(result) ? '' : s);
          setDisplay(s);
        }
        return;
      }
      // digit or '.'
      setEntry((e) => {
        if (key === '.' && (e.includes('.') || e === '')) return e === '' ? '0.' : e;
        if (e.length >= MAX_ENTRY) return e;
        return e === '0' && key !== '.' ? key : e + key;
      });
      setDisplay((d) => (d === '0' && key !== '.' ? key : d.length >= MAX_ENTRY + 1 ? d : d + key));
    },
    [acc, entry, op, tryUnlock],
  );

  if (!lock.hasCode) {
    return <Onboarding />;
  }

  return (
    <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={styles.container}>
      <View style={styles.displayWrap}>
        <Text style={styles.display} numberOfLines={1} adjustsFontSizeToFit>
          {display}
        </Text>
      </View>
      <View style={styles.pad}>
        {ROWS.map((row, i) => (
          <View key={i} style={styles.row}>
            {row.map((key) => (
              <CalcButton key={key} label={key} onPress={() => press(key)} />
            ))}
          </View>
        ))}
      </View>
    </KeyboardAvoidingView>
  );
}

function CalcButton({ label, onPress }: { label: string; onPress: () => void }) {
  const isOp = OP_KEYS.has(label) || label === '=';
  const isFn = label === 'AC' || label === '⌫';
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [
        styles.btn,
        isOp && styles.btnOp,
        isFn && styles.btnFn,
        label === '0' && styles.btnWide,
        pressed && { opacity: 0.7 },
      ]}
    >
      <Text style={[styles.btnText, (isOp || isFn) && styles.btnTextLight]}>{label}</Text>
    </Pressable>
  );
}

function Onboarding() {
  const lock = useLock();
  const router = useRouter();
  const [name, setName] = useState('');
  const [digits, setDigits] = useState('');
  const [opChar, setOpChar] = useState<string>('%');
  const [error, setError] = useState('');

  const code = `${digits}${opChar}`;
  const valid = useMemo(() => isValidPasscode(code) && name.trim().length > 0, [code, name]);

  const save = async () => {
    if (!valid) {
      setError('Pick a name and a code of 3–8 digits + an operator.');
      return;
    }
    try {
      await lock.setCode(name.trim(), code);
      router.replace('/chats');
    } catch {
      setError('Could not save. Try again.');
    }
  };

  return (
    <View style={[styles.container, styles.onboard]}>
      <Text style={styles.onboardTitle}>Welcome</Text>
      <Text style={styles.onboardSub}>
        Set the display name your contacts will see, and the secret code that opens
        this app from the calculator (3–8 digits + an operator, e.g. 1337%).
      </Text>
      <TextInput
        style={styles.input}
        placeholder="Display name"
        placeholderTextColor="#666"
        value={name}
        onChangeText={setName}
        maxLength={20}
      />
      <TextInput
        style={styles.input}
        placeholder="Secret digits (e.g. 1337)"
        placeholderTextColor="#666"
        value={digits}
        onChangeText={(t) => setDigits(t.replace(/[^0-9]/g, '').slice(0, 8))}
        keyboardType="number-pad"
        secureTextEntry
      />
      <View style={styles.opRow}>
        {PASSCODE_OPERATORS.map((o) => (
          <Pressable
            key={o}
            onPress={() => setOpChar(o)}
            style={[styles.opChip, opChar === o && styles.opChipActive]}
          >
            <Text style={styles.opChipText}>{o}</Text>
          </Pressable>
        ))}
      </View>
      <Text style={styles.preview}>Your unlock code: {code || '—'}</Text>
      {!!error && <Text style={styles.error}>{error}</Text>}
      <Pressable style={[styles.saveBtn, !valid && styles.saveBtnDisabled]} onPress={() => void save()}>
        <Text style={styles.saveBtnText}>Save & continue</Text>
      </Pressable>
    </View>
  );
}

const KEY_BG = '#1c1c1e';

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#000', justifyContent: 'flex-end' },
  displayWrap: { paddingHorizontal: 24, paddingBottom: 12, paddingTop: 80, alignItems: 'flex-end' },
  display: { color: '#fff', fontSize: 64, fontWeight: '300' },
  pad: { padding: 12, gap: 12 },
  row: { flexDirection: 'row', gap: 12 },
  btn: {
    flex: 1,
    aspectRatio: 1.25,
    borderRadius: 999,
    backgroundColor: KEY_BG,
    alignItems: 'center',
    justifyContent: 'center',
  },
  btnWide: { flex: 2.3 },
  btnOp: { backgroundColor: '#ff9f0a' },
  btnFn: { backgroundColor: '#2c2c2e' },
  btnText: { color: '#fff', fontSize: 28, fontWeight: '400' },
  btnTextLight: { color: '#fff', fontWeight: '600' },
  onboard: { justifyContent: 'center', padding: 28, gap: 14 },
  onboardTitle: { color: '#fff', fontSize: 28, fontWeight: '700' },
  onboardSub: { color: '#9a9aa0', fontSize: 14, lineHeight: 20, marginBottom: 10 },
  input: {
    backgroundColor: KEY_BG,
    color: '#fff',
    borderRadius: 12,
    paddingHorizontal: 16,
    paddingVertical: 14,
    fontSize: 16,
  },
  opRow: { flexDirection: 'row', gap: 10 },
  opChip: {
    paddingHorizontal: 18,
    paddingVertical: 10,
    borderRadius: 999,
    backgroundColor: KEY_BG,
  },
  opChipActive: { backgroundColor: '#ff9f0a' },
  opChipText: { color: '#fff', fontSize: 18 },
  preview: { color: '#8e8e93', fontSize: 13 },
  error: { color: '#ff453a', fontSize: 13 },
  saveBtn: { backgroundColor: '#0a84ff', borderRadius: 12, paddingVertical: 14, alignItems: 'center' },
  saveBtnDisabled: { opacity: 0.4 },
  saveBtnText: { color: '#fff', fontWeight: '600', fontSize: 16 },
});
