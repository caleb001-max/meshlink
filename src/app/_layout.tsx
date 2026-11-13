import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { LockProvider } from '@/lib/lock';
import { colors } from '@/lib/theme';

export default function RootLayout() {
  return (
    <SafeAreaProvider>
      <LockProvider>
        <StatusBar style="light" />
        <Stack
          screenOptions={{
            headerShown: false,
            contentStyle: { backgroundColor: colors.jetBlack },
            animation: 'fade',
          }}
        >
          <Stack.Screen name="index" />
          <Stack.Screen name="chats" />
          <Stack.Screen name="chat/[id]" />
          <Stack.Screen name="nearby" />
          <Stack.Screen name="pair" />
          <Stack.Screen name="network" />
          <Stack.Screen name="security" />
          <Stack.Screen name="storage" />
          <Stack.Screen name="settings" />
        </Stack>
      </LockProvider>
    </SafeAreaProvider>
  );
}
