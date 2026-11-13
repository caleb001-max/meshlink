import { useCallback, useEffect, useState } from 'react';
import { Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import { useRequireUnlocked } from '@/lib/lock';
import { engine } from '@/lib/engine';
import { useEngineSnapshot } from '@/lib/hooks';
import type { ChatSummary } from '@/lib/engine/sqlite-store';
import { ActionButton, Card, Header, Pill, Screen, SectionLabel, ui } from '@/components/ui';
import { colors, radius, space, type } from '@/lib/theme';

const KIND_ICON: Record<string, string> = { text: '', image: 'IMG', voice: 'VOICE', sos: 'SOS' };

function previewOf(chat: ChatSummary): string {
  if (!chat.lastKind) return 'Paired — say hello';
  if (chat.lastKind === 'image') return 'Photo';
  if (chat.lastKind === 'voice') return 'Voice note';
  if (chat.lastKind === 'sos') return `SOS: ${chat.lastBody}`;
  return chat.lastBody || 'Empty message';
}

export default function ChatsScreen() {
  const ready = useRequireUnlocked();
  const router = useRouter();
  const snap = useEngineSnapshot();
  const [chats, setChats] = useState<ChatSummary[]>([]);
  const [refreshing, setRefreshing] = useState(false);

  const reload = useCallback(async () => {
    setChats(await engine.chats());
  }, []);

  useEffect(() => {
    if (!ready) return;
    void engine.start();
  }, [ready]);

  useEffect(() => {
    if (!ready) return;
    let alive = true;
    void engine.chats().then((next) => {
      if (alive) setChats(next);
    });
    return () => {
      alive = false;
    };
  }, [ready, snap.version]);

  if (!ready) return null;

  const relayLabel = snap.relayEnabled ? 'Relaying on' : 'Relaying off';
  const transport = snap.lan.running
    ? `${snap.lan.ip ?? 'LAN'} · ${snap.lan.peers} link${snap.lan.peers === 1 ? '' : 's'}`
    : 'LAN unavailable';

  return (
    <Screen>
      <Header
        title="MeshLink"
        subtitle={snap.starting ? 'Starting mesh…' : snap.started ? `${transport} · ${relayLabel}` : snap.error ?? 'Starting mesh…'}
        right={
          <>
            <HeaderButton label="Pair" onPress={() => router.push('/pair')} />
            <HeaderButton label="Nearby" onPress={() => router.push('/nearby')} />
            <HeaderButton label="Settings" onPress={() => router.push('/settings')} />
          </>
        }
      />

      <ScrollView
        contentContainerStyle={styles.scroll}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            tintColor={colors.flame}
            onRefresh={() => {
              setRefreshing(true);
              void reload().finally(() => setRefreshing(false));
            }}
          />
        }
      >
        {!!snap.error && (
          <Card style={styles.warningCard}>
            <Text style={styles.warningText}>{snap.error}</Text>
          </Card>
        )}

        <Card style={styles.statusCard}>
          <View style={styles.statusRow}>
            <View style={[styles.dot, { backgroundColor: snap.started ? colors.flame : colors.faint }]} />
            <Text style={styles.statusTitle}>{snap.started ? 'Mesh running' : 'Not running'}</Text>
            <Pill label={relayLabel} tone={snap.relayEnabled ? 'flame' : 'neutral'} />
          </View>
          <Text style={ui.muted}>
            {snap.links.length} secured link{snap.links.length === 1 ? '' : 's'} · queue {snap.queueSize} ·{' '}
            {snap.contacts} contact{snap.contacts === 1 ? '' : 's'}
          </Text>
          {!snap.relayEnabled && (
            <Text style={ui.faint}>
              Relaying is off. Enable it in Network if you want to carry other people&apos;s
              encrypted messages.
            </Text>
          )}
        </Card>

        {snap.requestCount > 0 && (
          <Card style={styles.requestCard}>
            <Text style={styles.requestTitle}>
              {snap.requestCount} message request{snap.requestCount === 1 ? '' : 's'}
            </Text>
            <Text style={ui.muted}>
              People you have not accepted yet can only reach you through message requests. Open a conversation marked
              Request to accept or block.
            </Text>
          </Card>
        )}

        <SectionLabel>Conversations</SectionLabel>
        {chats.length === 0 ? (
          <View style={styles.empty}>
            <View style={styles.emptyMark}>
              <View style={styles.emptyRing} />
              <View style={styles.emptyDot} />
            </View>
            <Text style={styles.emptyTitle}>No conversations yet</Text>
            <Text style={styles.emptyText}>
              Pair with someone by QR, or open Nearby to find people on the same Wi-Fi or
              hotspot. Messages can hop through other MeshLink phones.
            </Text>
            <View style={styles.emptyActions}>
              <ActionButton label="Scan QR" onPress={() => router.push('/pair')} style={styles.emptyBtn} />
              <ActionButton label="Nearby" kind="ghost" onPress={() => router.push('/nearby')} style={styles.emptyBtn} />
            </View>
          </View>
        ) : (
          chats.map((c) => (
            <Pressable key={c.contactId} style={styles.chatRow} onPress={() => router.push(`/chat/${c.contactId}`)}>
              <View style={styles.avatar}>
                <Text style={styles.avatarText}>{(c.name || '?').slice(0, 1).toUpperCase()}</Text>
              </View>
              <View style={styles.chatMain}>
                <View style={styles.nameRow}>
                  <Text style={styles.chatName} numberOfLines={1}>
                    {c.name || 'Unknown'}
                  </Text>
                  {!c.trusted && <Pill label="Request" tone="danger" />}
                  {!c.lastKind && <Pill label="Paired" />}
                </View>
                <Text style={styles.chatPreview} numberOfLines={1}>
                  {c.lastDirection === 'out' ? 'You: ' : ''}
                  {KIND_ICON[c.lastKind] ? `[${KIND_ICON[c.lastKind]}] ` : ''}
                  {previewOf(c)}
                </Text>
              </View>
              <Text style={styles.time}>
                {new Date(c.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
              </Text>
            </Pressable>
          ))
        )}
      </ScrollView>
    </Screen>
  );
}

function HeaderButton({ label, onPress }: { label: string; onPress: () => void }) {
  return (
    <Pressable onPress={onPress} style={styles.headerBtn} accessibilityRole="button" accessibilityLabel={label}>
      <Text style={styles.headerBtnText}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  scroll: { paddingBottom: 40 },
  headerBtn: {
    paddingHorizontal: 10,
    paddingVertical: 8,
    borderRadius: radius.sm,
    backgroundColor: colors.raised,
    borderWidth: 1,
    borderColor: colors.line,
  },
  headerBtnText: { color: colors.softWhite, fontSize: 12, fontWeight: '700' },
  statusCard: { marginTop: space.sm },
  statusRow: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  dot: { width: 8, height: 8, borderRadius: 4 },
  statusTitle: { ...type.heading, color: colors.softWhite, flex: 1 },
  warningCard: { borderColor: colors.danger, backgroundColor: colors.dangerWash },
  warningText: { color: colors.danger, fontSize: 13, lineHeight: 19 },
  requestCard: { borderColor: 'rgba(255,90,31,0.35)', backgroundColor: colors.flameWash },
  requestTitle: { ...type.heading, color: colors.flame },
  empty: { alignItems: 'center', paddingHorizontal: 34, paddingTop: 40, gap: 12 },
  emptyMark: { width: 84, height: 84, alignItems: 'center', justifyContent: 'center', marginBottom: 4 },
  emptyRing: {
    position: 'absolute',
    width: 84,
    height: 84,
    borderRadius: 42,
    borderWidth: 1,
    borderColor: 'rgba(255,90,31,0.4)',
  },
  emptyDot: { width: 28, height: 28, borderRadius: 14, backgroundColor: colors.flame },
  emptyTitle: { ...type.heading, color: colors.softWhite },
  emptyText: { color: colors.muted, fontSize: 14, lineHeight: 21, textAlign: 'center' },
  emptyActions: { flexDirection: 'row', gap: space.sm, marginTop: 8, width: '100%' },
  emptyBtn: { flex: 1 },
  chatRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: space.lg,
    paddingVertical: 12,
    gap: 12,
  },
  avatar: {
    width: 48,
    height: 48,
    borderRadius: 24,
    backgroundColor: colors.raised,
    borderWidth: 1,
    borderColor: 'rgba(255,90,31,0.4)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  avatarText: { color: colors.flame, fontSize: 20, fontWeight: '800' },
  chatMain: { flex: 1, gap: 3 },
  nameRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  chatName: { color: colors.softWhite, fontSize: 16, fontWeight: '700', flexShrink: 1 },
  chatPreview: { color: colors.muted, fontSize: 13 },
  time: { color: colors.faint, fontSize: 11 },
});
