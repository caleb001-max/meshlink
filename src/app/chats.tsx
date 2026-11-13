import { useEffect, useState, useSyncExternalStore } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import { useRequireUnlocked, useLock } from '@/lib/lock';
import { mesh } from '@/lib/mesh';
import { subscribeMesh } from '@/lib/hooks';
import { listChats, type ChatSummary } from '@/lib/db';

const KIND_ICON: Record<string, string> = { text: '', photo: '📷', audio: '🎙' };

export default function ChatsScreen() {
  const ready = useRequireUnlocked();
  const router = useRouter();
  const lock = useLock();
  useSyncExternalStore(subscribeMesh, () => mesh.version);
  const [chats, setChats] = useState<ChatSummary[]>([]);

  useEffect(() => {
    void mesh.start();
  }, []);

  useEffect(() => {
    void listChats().then(setChats);
  }, [mesh.version]);

  if (!ready) return null;

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <Text style={styles.title}>Chats</Text>
        <View style={styles.headerBtns}>
          <Pressable style={styles.iconBtn} onPress={() => router.push('/nearby')}>
            <Text style={styles.iconText}>⚡</Text>
          </Pressable>
          <Pressable style={styles.iconBtn} onPress={() => router.push('/settings')}>
            <Text style={styles.iconText}>⚙</Text>
          </Pressable>
          <Pressable style={styles.iconBtn} onPress={lock.lock}>
            <Text style={styles.iconText}>🔒</Text>
          </Pressable>
        </View>
      </View>

      <ScrollView contentContainerStyle={chats.length === 0 ? styles.emptyWrap : undefined}>
        {chats.length === 0 && (
          <Text style={styles.empty}>
            No conversations yet.{'\n'}Open ⚡ Nearby to discover people on your Wi-Fi,
            hotspot, or (best-effort) Bluetooth mesh — messages can bounce through
            other devices to reach the target.
          </Text>
        )}
        {chats.map((c) => (
          <Pressable key={c.peer} style={styles.chatRow} onPress={() => router.push(`/chat/${c.peer}`)}>
            <View style={styles.avatar}>
              <Text style={styles.avatarText}>{(c.name || '?').slice(0, 1).toUpperCase()}</Text>
            </View>
            <View style={styles.chatMain}>
              <Text style={styles.chatName} numberOfLines={1}>
                {c.name}
              </Text>
              <Text style={styles.chatPreview} numberOfLines={1}>
                {KIND_ICON[c.lastKind] ?? ''} {c.lastBody || (c.lastKind === 'photo' ? 'Photo' : 'Voice note')}
              </Text>
            </View>
            <Text style={styles.time}>{new Date(c.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</Text>
          </Pressable>
        ))}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#101012' },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 18,
    paddingTop: 60,
    paddingBottom: 14,
  },
  title: { color: '#fff', fontSize: 30, fontWeight: '800' },
  headerBtns: { flexDirection: 'row', gap: 10 },
  iconBtn: {
    width: 42,
    height: 42,
    borderRadius: 21,
    backgroundColor: '#1c1c1e',
    alignItems: 'center',
    justifyContent: 'center',
  },
  iconText: { color: '#fff', fontSize: 18 },
  emptyWrap: { flex: 1, justifyContent: 'center' },
  empty: { color: '#8e8e93', textAlign: 'center', padding: 32, lineHeight: 22 },
  chatRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 18,
    paddingVertical: 12,
    gap: 12,
  },
  avatar: {
    width: 48,
    height: 48,
    borderRadius: 24,
    backgroundColor: '#0a84ff',
    alignItems: 'center',
    justifyContent: 'center',
  },
  avatarText: { color: '#fff', fontSize: 20, fontWeight: '700' },
  chatMain: { flex: 1, gap: 2 },
  chatName: { color: '#fff', fontSize: 16, fontWeight: '600' },
  chatPreview: { color: '#8e8e93', fontSize: 14 },
  time: { color: '#6b6b70', fontSize: 12 },
});
