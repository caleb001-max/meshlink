import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { LockProvider } from '@/lib/lock';

export default function RootLayout() {
  return (
    <LockProvider>
      <StatusBar style="light" />
      <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: '#101012' } }}>
        <Stack.Screen name="index" />
        <Stack.Screen name="chats" />
        <Stack.Screen name="chat/[id]" />
        <Stack.Screen name="call/[id]" />
        <Stack.Screen name="nearby" />
        <Stack.Screen name="settings" />
      </Stack>
    </LockProvider>
  );
}
