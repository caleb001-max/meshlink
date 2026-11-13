import { useCallback, useEffect, useRef, useState } from 'react';
import { Alert, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import { CameraView, useCameraPermissions } from 'expo-camera';
import QRCode from 'react-native-qrcode-svg';
import { useRequireUnlocked } from '@/lib/lock';
import { engine } from '@/lib/engine';
import { ActionButton, Card, Header, Screen, SectionLabel, ui } from '@/components/ui';
import { colors, radius, space, type } from '@/lib/theme';

type Mode = 'show' | 'scan';

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : 'Pairing failed.';
}

export default function PairScreen() {
  const ready = useRequireUnlocked();
  const router = useRouter();
  const [mode, setMode] = useState<Mode>('show');
  const [payload, setPayload] = useState<string | null>(null);
  const [permission, requestPermission] = useCameraPermissions();
  const [busy, setBusy] = useState(false);
  const handled = useRef(false);

  useEffect(() => {
    if (!ready) return;
    void engine
      .start()
      .then(() => setPayload(engine.qrPayload()))
      .catch((err) => Alert.alert('Engine not ready', errorText(err)));
  }, [ready]);

  const handleScan = useCallback(
    async (data: string) => {
      if (handled.current || busy) return;
      handled.current = true;
      setBusy(true);
      try {
        const contactId = await engine.pairFromQr(data);
        router.replace(`/chat/${contactId}`);
      } catch (err) {
        Alert.alert('Not a MeshLink code', errorText(err));
        handled.current = false;
      } finally {
        setBusy(false);
      }
    },
    [busy, router],
  );

  if (!ready) return null;

  return (
    <Screen>
      <Header title="Pair" subtitle="Add a contact out of band" onBack={() => router.back()} />
      <ScrollView contentContainerStyle={styles.content}>
        <View style={styles.tabs}>
          <Pressable
            style={[styles.tab, mode === 'show' && styles.tabActive]}
            onPress={() => setMode('show')}
            accessibilityRole="button"
          >
            <Text style={[styles.tabText, mode === 'show' && styles.tabTextActive]}>My code</Text>
          </Pressable>
          <Pressable
            style={[styles.tab, mode === 'scan' && styles.tabActive]}
            onPress={() => setMode('scan')}
            accessibilityRole="button"
          >
            <Text style={[styles.tabText, mode === 'scan' && styles.tabTextActive]}>Scan</Text>
          </Pressable>
        </View>

        {mode === 'show' ? (
          <>
            <Card style={styles.qrCard}>
              <View style={styles.qrFrame}>
                {payload ? (
                  <QRCode value={payload} size={272} ecl="L" color={colors.jetBlack} backgroundColor={colors.softWhite} />
                ) : (
                  <Text style={styles.qrLoading}>Preparing your public bundle…</Text>
                )}
              </View>
              <Text style={styles.qrCaption}>
                This code contains only public keys and a signed prekey bundle. No secrets, no name history.
              </Text>
            </Card>
            <SectionLabel>How pairing works</SectionLabel>
            <Card>
              <Text style={ui.body}>1. Your contact opens Pair → Scan and points their camera here.</Text>
              <Text style={ui.body}>
                2. Their device verifies your prekey signature before saving you. You appear as a trusted contact.
              </Text>
              <Text style={ui.body}>
                3. Compare the safety number in Security in person. Verification is a separate, explicit step.
              </Text>
            </Card>
            <Card style={styles.note}>
              <Text style={styles.noteText}>
                Pairing is out of band on purpose: no directory, no account, no server. If you cannot meet, send your
                code through a channel you already trust.
              </Text>
            </Card>
          </>
        ) : (
          <>
            {permission?.granted ? (
              <View style={styles.scanner}>
                <CameraView
                  style={StyleSheet.absoluteFill}
                  facing="back"
                  barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
                  onBarcodeScanned={busy ? undefined : ({ data }) => void handleScan(data)}
                />
                <View style={styles.reticle} pointerEvents="none" />
              </View>
            ) : (
              <Card>
                <Text style={ui.body}>Camera access is needed to scan a pairing code.</Text>
                <ActionButton label="Allow camera" onPress={() => void requestPermission()} />
              </Card>
            )}
            <Text style={styles.scanHint}>
              {busy ? 'Verifying prekey bundle…' : 'Point the camera at the other device’s code. Nothing is uploaded.'}
            </Text>
          </>
        )}
      </ScrollView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  content: { paddingBottom: space.xxl },
  tabs: {
    flexDirection: 'row',
    gap: space.xs,
    marginHorizontal: space.lg,
    marginBottom: space.md,
    padding: 3,
    borderRadius: radius.md,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.line,
  },
  tab: { flex: 1, paddingVertical: space.sm, borderRadius: radius.sm, alignItems: 'center' },
  tabActive: { backgroundColor: colors.flame },
  tabText: { color: colors.muted, fontWeight: '700', fontSize: 14 },
  tabTextActive: { color: colors.jetBlack },
  qrCard: { alignItems: 'center', paddingVertical: space.xl },
  qrFrame: {
    padding: space.md,
    borderRadius: radius.md,
    backgroundColor: colors.softWhite,
    minWidth: 296,
    minHeight: 296,
    alignItems: 'center',
    justifyContent: 'center',
  },
  qrLoading: { color: colors.jetBlack, fontSize: 13 },
  qrCaption: { color: colors.faint, fontSize: 12, lineHeight: 17, textAlign: 'center' },
  note: { backgroundColor: colors.flameWash, borderColor: 'rgba(255,90,31,0.35)' },
  noteText: { color: colors.softWhite, fontSize: 12, lineHeight: 18 },
  scanner: {
    height: 380,
    marginHorizontal: space.lg,
    marginBottom: space.md,
    borderRadius: radius.lg,
    overflow: 'hidden',
    borderWidth: 1,
    borderColor: colors.line,
  },
  reticle: {
    position: 'absolute',
    top: '18%',
    left: '14%',
    width: '72%',
    height: '64%',
    borderRadius: radius.lg,
    borderWidth: 2,
    borderColor: colors.flame,
  },
  scanHint: {
    ...type.caption,
    color: colors.muted,
    textAlign: 'center',
    paddingHorizontal: space.xl,
    paddingTop: space.sm,
  },
});
