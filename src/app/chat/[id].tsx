import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import {
  Alert,
  FlatList,
  Image,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
  Modal,
} from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
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
import { mesh } from '@/lib/mesh';
import { subscribeMesh } from '@/lib/hooks';
import { getPeer, listMessages, type Message } from '@/lib/db';
import { b64ToBytes } from '@/lib/codec';

export default function ChatScreen() {
  const ready = useRequireUnlocked();
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id: string }>();
  const peerPk = String(id ?? '');

  useSyncExternalVersion();
  const [messages, setMessages] = useState<Message[]>([]);
  const [draft, setDraft] = useState('');
  const [cameraOpen, setCameraOpen] = useState(false);
  const [peerName, setPeerName] = useState('…');
  const [playingUri, setPlayingUri] = useState<string | null>(null);

  const [camPermission, requestCamPermission] = useCameraPermissions();
  const cameraRef = useRef<CameraView>(null);

  const recorder = useAudioRecorder(RecordingPresets.LOW_QUALITY);
  const recState = useAudioRecorderState(recorder);
  const player = useAudioPlayer(playingUri);

  useEffect(() => {
    void getPeer(peerPk).then((p) => setPeerName(p?.name ?? 'Unknown'));
  }, [peerPk, mesh.version]);

  useEffect(() => {
    void listMessages(peerPk).then(setMessages);
  }, [peerPk, mesh.version]);

  useEffect(() => {
    if (player && playingUri) player.play();
  }, [player, playingUri]);

  const sendText = useCallback(() => {
    const text = draft.trim();
    if (!text || !peerPk) return;
    setDraft('');
    void mesh.sendMessage(peerPk, 'text', text, null);
  }, [draft, peerPk]);

  const takePhoto = useCallback(async () => {
    if (!cameraRef.current || !peerPk) return;
    const shot = await cameraRef.current.takePictureAsync({ quality: 0.35, base64: true, exif: false });
    setCameraOpen(false);
    if (shot?.base64) void mesh.sendMessage(peerPk, 'photo', '', shot.base64);
  }, [peerPk]);

  const startRecording = useCallback(async () => {
    const perm = await AudioModule.requestRecordingPermissionsAsync();
    if (!perm.granted) {
      Alert.alert('Microphone needed', 'Grant microphone access to record voice notes.');
      return;
    }
    await setAudioModeAsync({ allowsRecording: true, playsInSilentMode: true });
    await recorder.prepareToRecordAsync();
    recorder.record();
  }, [recorder]);

  const stopRecording = useCallback(async () => {
    await recorder.stop();
    await setAudioModeAsync({ allowsRecording: false });
    const uri = recorder.uri;
    if (!uri || !peerPk) return;
    const media = await new File(uri).base64();
    void mesh.sendMessage(peerPk, 'audio', '', media);
  }, [recorder, peerPk]);

  const playVoiceNote = useCallback(
    async (media: string, mid: string) => {
      const f = new File(Paths.cache, `vn-${mid}.m4a`);
      if (!f.exists) await f.write(b64ToBytes(media));
      setPlayingUri(f.uri);
    },
    [],
  );

  if (!ready) return null;

  return (
    <KeyboardAvoidingView style={styles.container} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <View style={styles.header}>
        <Pressable onPress={() => router.back()} style={styles.backBtn}>
          <Text style={styles.backText}>‹</Text>
        </Pressable>
        <Text style={styles.peerName} numberOfLines={1}>
          {peerName}
        </Text>
        <Pressable onPress={() => router.push(`/call/${peerPk}`)} style={styles.callBtn}>
          <Text style={styles.callIcon}>📞</Text>
        </Pressable>
      </View>

      <FlatList
        data={messages}
        keyExtractor={(m) => m.id}
        contentContainerStyle={styles.list}
        renderItem={({ item }) => (
          <View style={[styles.bubble, item.fromMe ? styles.mine : styles.theirs]}>
            {item.kind === 'photo' && item.media ? (
              <Image
                style={styles.photo}
                source={{ uri: `data:image/jpeg;base64,${item.media}` }}
              />
            ) : item.kind === 'audio' && item.media ? (
              <Pressable onPress={() => void playVoiceNote(item.media!, item.id)} style={styles.audioBtn}>
                <Text style={styles.audioText}>🎙 Voice note — tap to play</Text>
              </Pressable>
            ) : (
              <Text style={styles.bubbleText}>{item.body}</Text>
            )}
            <Text style={styles.tick}>
              {new Date(item.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
              {item.fromMe ? (item.status === 'delivered' ? ' ✓✓' : ' ✓') : ''}
            </Text>
          </View>
        )}
      />

      {recState.isRecording && <Text style={styles.recording}>● recording… tap 🎙 to stop & send</Text>}

      <View style={styles.inputRow}>
        <Pressable
          style={styles.toolBtn}
          onPress={() => (recState.isRecording ? void stopRecording() : void startRecording())}
        >
          <Text style={styles.toolText}>{recState.isRecording ? '⏹' : '🎙'}</Text>
        </Pressable>
        <Pressable
          style={styles.toolBtn}
          onPress={() => {
            if (!camPermission?.granted) void requestCamPermission();
            setCameraOpen(true);
          }}
        >
          <Text style={styles.toolText}>📷</Text>
        </Pressable>
        <TextInput
          style={styles.input}
          placeholder="Message"
          placeholderTextColor="#666"
          value={draft}
          onChangeText={setDraft}
          multiline
        />
        <Pressable style={styles.sendBtn} onPress={sendText}>
          <Text style={styles.sendText}>➤</Text>
        </Pressable>
      </View>

      <Modal visible={cameraOpen} animationType="slide">
        <View style={styles.cameraWrap}>
          <CameraView ref={cameraRef} style={styles.camera} facing="back" />
          <View style={styles.cameraBar}>
            <Pressable onPress={() => setCameraOpen(false)} style={styles.cameraCancel}>
              <Text style={styles.cameraCancelText}>Cancel</Text>
            </Pressable>
            <Pressable onPress={() => void takePhoto()} style={styles.shutter}>
              <View style={styles.shutterInner} />
            </Pressable>
            <View style={styles.cameraCancel} />
          </View>
        </View>
      </Modal>
    </KeyboardAvoidingView>
  );
}

function useSyncExternalVersion(): void {
  useSyncExternalStore(subscribeMesh, () => mesh.version);
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#101012' },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingHorizontal: 14,
    paddingTop: 56,
    paddingBottom: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#2c2c2e',
  },
  backBtn: { width: 36, height: 36, alignItems: 'center', justifyContent: 'center' },
  backText: { color: '#0a84ff', fontSize: 30, marginTop: -4 },
  peerName: { flex: 1, color: '#fff', fontSize: 18, fontWeight: '700' },
  callBtn: {
    width: 42,
    height: 42,
    borderRadius: 21,
    backgroundColor: '#1c1c1e',
    alignItems: 'center',
    justifyContent: 'center',
  },
  callIcon: { fontSize: 18 },
  list: { padding: 12, gap: 8 },
  bubble: { maxWidth: '78%', borderRadius: 16, padding: 10, gap: 4 },
  mine: { alignSelf: 'flex-end', backgroundColor: '#0a84ff' },
  theirs: { alignSelf: 'flex-start', backgroundColor: '#1c1c1e' },
  bubbleText: { color: '#fff', fontSize: 16, lineHeight: 21 },
  tick: { color: 'rgba(255,255,255,0.6)', fontSize: 10, alignSelf: 'flex-end' },
  photo: { width: 220, height: 220, borderRadius: 10 },
  audioBtn: { paddingVertical: 6 },
  audioText: { color: '#fff', fontSize: 15 },
  recording: { color: '#ff453a', textAlign: 'center', paddingBottom: 4, fontSize: 12 },
  inputRow: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: 8,
    padding: 10,
    paddingBottom: 20,
  },
  toolBtn: {
    width: 42,
    height: 42,
    borderRadius: 21,
    backgroundColor: '#1c1c1e',
    alignItems: 'center',
    justifyContent: 'center',
  },
  toolText: { fontSize: 18 },
  input: {
    flex: 1,
    backgroundColor: '#1c1c1e',
    borderRadius: 20,
    color: '#fff',
    paddingHorizontal: 16,
    paddingTop: 10,
    paddingBottom: 10,
    maxHeight: 110,
    fontSize: 15,
  },
  sendBtn: {
    width: 42,
    height: 42,
    borderRadius: 21,
    backgroundColor: '#0a84ff',
    alignItems: 'center',
    justifyContent: 'center',
  },
  sendText: { color: '#fff', fontSize: 18 },
  cameraWrap: { flex: 1, backgroundColor: '#000' },
  camera: { flex: 1 },
  cameraBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: 24,
  },
  cameraCancel: { width: 60, alignItems: 'center' },
  cameraCancelText: { color: '#fff', fontSize: 16 },
  shutter: {
    width: 72,
    height: 72,
    borderRadius: 36,
    backgroundColor: '#fff',
    alignItems: 'center',
    justifyContent: 'center',
  },
  shutterInner: { width: 60, height: 60, borderRadius: 30, backgroundColor: '#fff', borderWidth: 2, borderColor: '#000' },
});
