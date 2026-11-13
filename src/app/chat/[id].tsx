import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Alert,
  FlatList,
  Image,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { CameraView, useCameraPermissions } from 'expo-camera';
import {
  AudioModule,
  RecordingPresets,
  setAudioModeAsync,
  useAudioPlayer,
  useAudioRecorder,
  useAudioRecorderState,
} from 'expo-audio';
import { File, Paths } from 'expo-file-system';
import { useRequireUnlocked } from '@/lib/lock';
import { engine } from '@/lib/engine';
import { useEngineSnapshot } from '@/lib/hooks';
import { b64ToBytes } from '@/lib/core/bytes';
import type { ContactRecord, MessageRecord } from '@/lib/core/store';
import { colors, radius, space, type } from '@/lib/theme';

const VOICE_CAP_MS = 30_000;

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : 'Something went wrong.';
}

function timeLabel(ts: number): string {
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function statusLabel(m: MessageRecord): string {
  switch (m.status) {
    case 'queued':
      return 'Queued · no route yet';
    case 'handed':
      return 'Handed to relay';
    case 'delivered':
      return 'Delivered';
    case 'read':
      return 'Read';
    case 'failed':
      return 'Failed';
    default:
      return '';
  }
}

export default function ChatScreen() {
  const ready = useRequireUnlocked();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { id } = useLocalSearchParams<{ id: string }>();
  const peerId = String(id ?? '');
  const snap = useEngineSnapshot();

  const [contact, setContact] = useState<ContactRecord | null>(null);
  const [messages, setMessages] = useState<MessageRecord[]>([]);
  const [draft, setDraft] = useState('');
  const [cameraOpen, setCameraOpen] = useState(false);
  const [playingUri, setPlayingUri] = useState<string | undefined>(undefined);
  const [busy, setBusy] = useState(false);

  const listRef = useRef<FlatList<MessageRecord>>(null);
  const voiceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [camPermission, requestCamPermission] = useCameraPermissions();
  const cameraRef = useRef<CameraView>(null);

  const recorder = useAudioRecorder(RecordingPresets.LOW_QUALITY);
  const recState = useAudioRecorderState(recorder);
  const player = useAudioPlayer(playingUri);

  useEffect(() => {
    if (!ready) return;
    void engine.start().catch(() => {
      /* snapshot.error carries the reason on screen */
    });
  }, [ready]);

  useEffect(() => {
    if (!ready || !peerId) return;
    let alive = true;
    void Promise.all([engine.contact(peerId), engine.messages(peerId)]).then(([c, m]) => {
      if (!alive) return;
      setContact(c);
      setMessages(m);
    });
    return () => {
      alive = false;
    };
  }, [ready, peerId, snap.version]);

  useEffect(() => {
    if (player && playingUri) player.play();
  }, [player, playingUri]);

  const sendText = useCallback(() => {
    const text = draft.trim();
    if (!text || !peerId) return;
    setDraft('');
    void engine.sendText(peerId, text).catch((err) => {
      setDraft(text);
      Alert.alert('Not sent', errorText(err));
    });
  }, [draft, peerId]);

  const takePhoto = useCallback(async () => {
    if (!cameraRef.current) return;
    try {
      const shot = await cameraRef.current.takePictureAsync({ quality: 0.25, base64: true, exif: false });
      setCameraOpen(false);
      if (!shot?.base64) return;
      setBusy(true);
      try {
        await engine.sendMedia(peerId, 'image', shot.base64);
      } finally {
        setBusy(false);
      }
    } catch (err) {
      Alert.alert('Photo not sent', errorText(err));
    }
  }, [peerId]);

  const stopRecording = useCallback(async () => {
    if (voiceTimer.current) {
      clearTimeout(voiceTimer.current);
      voiceTimer.current = null;
    }
    try {
      await recorder.stop();
    } finally {
      await setAudioModeAsync({ allowsRecording: false }).catch(() => {});
    }
    const uri = recorder.uri;
    if (!uri) return;
    setBusy(true);
    try {
      const media = await new File(uri).base64();
      await engine.sendMedia(peerId, 'voice', media);
    } catch (err) {
      Alert.alert('Voice note not sent', errorText(err));
    } finally {
      setBusy(false);
    }
  }, [recorder, peerId]);

  const startRecording = useCallback(async () => {
    const perm = await AudioModule.requestRecordingPermissionsAsync();
    if (!perm.granted) {
      Alert.alert('Microphone needed', 'Grant microphone access to record voice notes.');
      return;
    }
    await setAudioModeAsync({ allowsRecording: true, playsInSilentMode: true });
    await recorder.prepareToRecordAsync();
    recorder.record();
    if (voiceTimer.current) clearTimeout(voiceTimer.current);
    voiceTimer.current = setTimeout(() => {
      void stopRecording();
    }, VOICE_CAP_MS);
  }, [recorder, stopRecording]);

  useEffect(() => {
    return () => {
      if (voiceTimer.current) clearTimeout(voiceTimer.current);
    };
  }, []);

  const playVoiceNote = useCallback(async (media: string, mid: string) => {
    const file = new File(Paths.cache, `vn-${mid}.m4a`);
    if (!file.exists) await file.write(b64ToBytes(media));
    setPlayingUri(undefined);
    setPlayingUri(file.uri);
  }, []);

  if (!ready) return null;

  const stranger = !!contact && !contact.trusted && !contact.blocked;
  const blocked = !!contact?.blocked;
  const name = contact?.name ?? 'Unknown contact';
  const canCompose = !blocked && !stranger;

  return (
    <KeyboardAvoidingView
      style={styles.container}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      keyboardVerticalOffset={0}
    >
      <View style={[styles.header, { paddingTop: insets.top + space.sm }]}>
        <Pressable onPress={() => router.back()} style={styles.backBtn} hitSlop={10} accessibilityLabel="Back">
          <Text style={styles.backText}>‹</Text>
        </Pressable>
        <View style={styles.avatar}>
          <Text style={styles.avatarText}>{name.slice(0, 1).toUpperCase()}</Text>
        </View>
        <View style={styles.headerMain}>
          <Text style={styles.peerName} numberOfLines={1}>
            {name}
          </Text>
          <Text style={styles.headerSub} numberOfLines={1}>
            {blocked
              ? 'Blocked'
              : stranger
                ? 'Message request'
                : contact?.verified
                  ? 'Verified contact · sealed end-to-end'
                  : 'Sealed end-to-end'}
          </Text>
        </View>
        <Pressable
          onPress={() => router.push('/security')}
          style={styles.infoBtn}
          hitSlop={8}
          accessibilityLabel="Contact security"
        >
          <Text style={styles.infoText}>i</Text>
        </Pressable>
      </View>

      {blocked ? (
        <View style={styles.banner}>
          <Text style={styles.bannerTitle}>This contact is blocked</Text>
          <Text style={styles.bannerBody}>Their messages are discarded before they reach this screen.</Text>
          <Pressable
            style={styles.bannerGhost}
            onPress={() => void engine.setBlocked(peerId, false).catch((err) => Alert.alert('Unblock failed', errorText(err)))}
          >
            <Text style={styles.bannerGhostText}>Unblock</Text>
          </Pressable>
        </View>
      ) : stranger ? (
        <View style={styles.banner}>
          <Text style={styles.bannerTitle}>Message request</Text>
          <Text style={styles.bannerBody}>
            Accept to add {name} to your contacts and unlock replies. Nothing is delivered until you choose.
          </Text>
          <View style={styles.bannerRow}>
            <Pressable
              style={styles.bannerAccept}
              onPress={() => void engine.acceptRequest(peerId).catch((err) => Alert.alert('Could not accept', errorText(err)))}
            >
              <Text style={styles.bannerAcceptText}>Accept</Text>
            </Pressable>
            <Pressable
              style={styles.bannerGhost}
              onPress={() => void engine.setBlocked(peerId, true).catch((err) => Alert.alert('Block failed', errorText(err)))}
            >
              <Text style={styles.bannerGhostText}>Block</Text>
            </Pressable>
          </View>
        </View>
      ) : null}

      <FlatList
        ref={listRef}
        data={messages.filter((m) => m.status !== 'request')}
        keyExtractor={(m) => m.id}
        contentContainerStyle={styles.list}
        onContentSizeChange={() => listRef.current?.scrollToEnd({ animated: false })}
        renderItem={({ item }) => {
          const mine = item.direction === 'out';
          return (
            <View style={[styles.bubble, mine ? styles.mine : styles.theirs]}>
              {item.kind === 'image' && item.media ? (
                <Image style={styles.photo} source={{ uri: `data:image/jpeg;base64,${item.media}` }} />
              ) : item.kind === 'voice' && item.media ? (
                <Pressable onPress={() => void playVoiceNote(item.media!, item.id)} style={styles.audioBtn}>
                  <Text style={[styles.audioText, mine && styles.audioTextMine]}>▶ Voice note</Text>
                  <Text style={[styles.audioHint, mine && styles.audioHintMine]}>Tap to play</Text>
                </Pressable>
              ) : (
                <Text style={[styles.bubbleText, mine && styles.bubbleTextMine]}>{item.body}</Text>
              )}
              {mine ? (
                <View style={styles.metaRow}>
                  <Text style={styles.metaMine}>{timeLabel(item.ts)}</Text>
                  {statusLabel(item) ? <Text style={styles.metaMine}> · {statusLabel(item)}</Text> : null}
                </View>
              ) : (
                <Text style={styles.meta}>{timeLabel(item.ts)}</Text>
              )}
            </View>
          );
        }}
        ListEmptyComponent={
          <View style={styles.empty}>
            <Text style={styles.emptyTitle}>No messages here yet</Text>
            <Text style={styles.emptyBody}>
              Anything you send is sealed on this device and travels only when a route exists.
            </Text>
          </View>
        }
      />

      {recState.isRecording ? (
        <Text style={styles.recording}>
          ● Recording {Math.min(VOICE_CAP_MS, recState.durationMillis) / 1000 | 0}s / 30s · tap ⏹ to send
        </Text>
      ) : null}
      {busy ? <Text style={styles.recording}>Preparing attachment…</Text> : null}

      <View style={[styles.inputRow, { paddingBottom: Math.max(insets.bottom, space.md) }]}>
        <Pressable
          style={[styles.toolBtn, (!canCompose || busy) && styles.toolBtnOff]}
          disabled={!canCompose || busy}
          onPress={() => (recState.isRecording ? void stopRecording() : void startRecording())}
          accessibilityLabel={recState.isRecording ? 'Stop and send voice note' : 'Record voice note'}
        >
          <Text style={styles.toolText}>{recState.isRecording ? '⏹' : '🎙'}</Text>
        </Pressable>
        <Pressable
          style={[styles.toolBtn, (!canCompose || busy) && styles.toolBtnOff]}
          disabled={!canCompose || busy}
          onPress={() => {
            if (!camPermission?.granted) void requestCamPermission();
            setCameraOpen(true);
          }}
          accessibilityLabel="Take a photo"
        >
          <Text style={styles.toolText}>📷</Text>
        </Pressable>
        <TextInput
          style={styles.input}
          placeholder={blocked ? 'Unblock to reply' : stranger ? 'Accept the request to reply' : 'Message'}
          placeholderTextColor={colors.faint}
          value={draft}
          onChangeText={setDraft}
          editable={canCompose}
          multiline
        />
        <Pressable
          style={[styles.sendBtn, (!canCompose || !draft.trim()) && styles.sendBtnOff]}
          onPress={sendText}
          disabled={!canCompose || !draft.trim()}
          accessibilityLabel="Send message"
        >
          <Text style={styles.sendText}>➤</Text>
        </Pressable>
      </View>

      <Modal visible={cameraOpen} animationType="slide" onRequestClose={() => setCameraOpen(false)}>
        <View style={styles.cameraWrap}>
          <CameraView ref={cameraRef} style={styles.camera} facing="back" />
          <View style={[styles.cameraBar, { paddingBottom: Math.max(insets.bottom, space.xl) }]}>
            <Pressable onPress={() => setCameraOpen(false)} style={styles.cameraSide}>
              <Text style={styles.cameraCancelText}>Cancel</Text>
            </Pressable>
            <Pressable onPress={() => void takePhoto()} style={styles.shutter} accessibilityLabel="Capture photo">
              <View style={styles.shutterInner} />
            </Pressable>
            <View style={styles.cameraSide} />
          </View>
        </View>
      </Modal>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.jetBlack },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    paddingHorizontal: space.md,
    paddingBottom: space.md,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.line,
  },
  backBtn: { width: 32, height: 34, alignItems: 'center', justifyContent: 'center', marginLeft: -4 },
  backText: { color: colors.flame, fontSize: 32, lineHeight: 32, marginTop: -4 },
  avatar: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: colors.raised,
    borderWidth: 1,
    borderColor: colors.line,
    alignItems: 'center',
    justifyContent: 'center',
  },
  avatarText: { color: colors.flame, fontWeight: '800', fontSize: 15 },
  headerMain: { flex: 1, gap: 1 },
  peerName: { ...type.heading, color: colors.softWhite },
  headerSub: { color: colors.faint, fontSize: 11 },
  infoBtn: {
    width: 32,
    height: 32,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: colors.line,
    alignItems: 'center',
    justifyContent: 'center',
  },
  infoText: { color: colors.muted, fontWeight: '800', fontStyle: 'italic' },
  banner: {
    margin: space.md,
    marginBottom: 0,
    padding: space.md,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: 'rgba(255,90,31,0.35)',
    backgroundColor: colors.flameWash,
    gap: space.sm,
  },
  bannerRow: { flexDirection: 'row', gap: space.sm, marginTop: space.xs },
  bannerTitle: { color: colors.softWhite, fontWeight: '700', fontSize: 15 },
  bannerBody: { color: colors.muted, fontSize: 13, lineHeight: 19 },
  bannerAccept: {
    backgroundColor: colors.flame,
    borderRadius: radius.sm,
    paddingHorizontal: space.lg,
    paddingVertical: space.sm,
  },
  bannerAcceptText: { color: colors.jetBlack, fontWeight: '800', fontSize: 13 },
  bannerGhost: {
    borderWidth: 1,
    borderColor: colors.line,
    borderRadius: radius.sm,
    paddingHorizontal: space.lg,
    paddingVertical: space.sm,
    alignSelf: 'flex-start',
  },
  bannerGhostText: { color: colors.softWhite, fontWeight: '700', fontSize: 13 },
  list: { padding: space.md, gap: space.sm, flexGrow: 1 },
  bubble: {
    maxWidth: '80%',
    borderRadius: radius.lg,
    paddingHorizontal: space.md,
    paddingVertical: space.sm,
    gap: 2,
  },
  mine: { alignSelf: 'flex-end', backgroundColor: colors.flame, borderBottomRightRadius: 6 },
  theirs: {
    alignSelf: 'flex-start',
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.line,
    borderBottomLeftRadius: 6,
  },
  bubbleText: { color: colors.softWhite, fontSize: 15, lineHeight: 21 },
  bubbleTextMine: { color: colors.jetBlack },
  metaRow: { flexDirection: 'row', alignSelf: 'flex-end' },
  meta: { color: colors.faint, fontSize: 10, alignSelf: 'flex-end' },
  metaMine: { color: 'rgba(5,5,6,0.62)', fontSize: 10 },
  photo: { width: 220, height: 220, borderRadius: radius.md },
  audioBtn: { paddingVertical: 2, gap: 1 },
  audioText: { color: colors.softWhite, fontSize: 15, fontWeight: '700' },
  audioTextMine: { color: colors.jetBlack },
  audioHint: { color: colors.faint, fontSize: 11 },
  audioHintMine: { color: 'rgba(5,5,6,0.6)' },
  empty: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: space.xl, gap: space.sm },
  emptyTitle: { color: colors.softWhite, fontWeight: '700', fontSize: 16 },
  emptyBody: { color: colors.muted, textAlign: 'center', fontSize: 13, lineHeight: 19 },
  recording: { color: colors.flame, textAlign: 'center', paddingBottom: space.xs, fontSize: 12 },
  inputRow: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: space.sm,
    paddingHorizontal: space.md,
    paddingTop: space.sm,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.line,
  },
  toolBtn: {
    width: 42,
    height: 42,
    borderRadius: radius.pill,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.line,
    alignItems: 'center',
    justifyContent: 'center',
  },
  toolBtnOff: { opacity: 0.4 },
  toolText: { fontSize: 18 },
  input: {
    flex: 1,
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.line,
    color: colors.softWhite,
    paddingHorizontal: space.lg,
    paddingTop: 10,
    paddingBottom: 10,
    maxHeight: 110,
    fontSize: 15,
  },
  sendBtn: {
    width: 42,
    height: 42,
    borderRadius: radius.pill,
    backgroundColor: colors.flame,
    alignItems: 'center',
    justifyContent: 'center',
  },
  sendBtnOff: { opacity: 0.4 },
  sendText: { color: colors.jetBlack, fontSize: 17, fontWeight: '800' },
  cameraWrap: { flex: 1, backgroundColor: '#000' },
  camera: { flex: 1 },
  cameraBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: space.xl,
    paddingTop: space.xl,
  },
  cameraSide: { width: 64, alignItems: 'center' },
  cameraCancelText: { color: colors.softWhite, fontSize: 16 },
  shutter: {
    width: 72,
    height: 72,
    borderRadius: 36,
    backgroundColor: colors.softWhite,
    alignItems: 'center',
    justifyContent: 'center',
  },
  shutterInner: {
    width: 58,
    height: 58,
    borderRadius: 29,
    backgroundColor: colors.softWhite,
    borderWidth: 3,
    borderColor: colors.jetBlack,
  },
});
