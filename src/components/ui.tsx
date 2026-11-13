import type { ReactNode } from 'react';
import { Pressable, StyleSheet, Text, View, type StyleProp, type ViewStyle } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { colors, radius, space, type } from '@/lib/theme';

export function Screen({ children, style }: { children: ReactNode; style?: StyleProp<ViewStyle> }) {
  const insets = useSafeAreaInsets();
  return <View style={[{ flex: 1, backgroundColor: colors.jetBlack, paddingTop: insets.top }, style]}>{children}</View>;
}

export function Header({
  title,
  subtitle,
  onBack,
  right,
}: {
  title: string;
  subtitle?: string;
  onBack?: () => void;
  right?: ReactNode;
}) {
  return (
    <View style={styles.header}>
      {onBack ? (
        <Pressable onPress={onBack} style={styles.back} hitSlop={10} accessibilityLabel="Back">
          <Text style={styles.backText}>‹</Text>
        </Pressable>
      ) : null}
      <View style={styles.headerMain}>
        <Text style={styles.title} numberOfLines={1}>
          {title}
        </Text>
        {subtitle ? (
          <Text style={styles.subtitle} numberOfLines={2}>
            {subtitle}
          </Text>
        ) : null}
      </View>
      {right ? <View style={styles.headerRight}>{right}</View> : null}
    </View>
  );
}

export function Card({ children, style }: { children: ReactNode; style?: StyleProp<ViewStyle> }) {
  return <View style={[styles.card, style]}>{children}</View>;
}

export function SectionLabel({ children }: { children: string }) {
  return <Text style={styles.sectionLabel}>{children.toUpperCase()}</Text>;
}

export function ActionButton({
  label,
  onPress,
  kind = 'flame',
  disabled = false,
  compact = false,
  style,
}: {
  label: string;
  onPress: () => void;
  kind?: 'flame' | 'ghost' | 'danger';
  disabled?: boolean;
  compact?: boolean;
  style?: StyleProp<ViewStyle>;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        styles.button,
        compact && styles.buttonCompact,
        kind === 'flame' && styles.buttonFlame,
        kind === 'ghost' && styles.buttonGhost,
        kind === 'danger' && styles.buttonDanger,
        pressed && !disabled && styles.buttonPressed,
        disabled && styles.buttonDisabled,
        style,
      ]}
    >
      <Text
        style={[
          styles.buttonText,
          kind === 'flame' && styles.buttonTextOnFlame,
          kind === 'ghost' && styles.buttonTextGhost,
          kind === 'danger' && styles.buttonTextDanger,
        ]}
      >
        {label}
      </Text>
    </Pressable>
  );
}

export function Pill({ label, tone = 'neutral' }: { label: string; tone?: 'neutral' | 'flame' | 'danger' }) {
  return (
    <View style={[styles.pill, tone === 'flame' && styles.pillFlame, tone === 'danger' && styles.pillDanger]}>
      <Text style={[styles.pillText, tone === 'flame' && styles.pillTextFlame, tone === 'danger' && styles.pillTextDanger]}>
        {label}
      </Text>
    </View>
  );
}

export const ui = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center' },
  gap: { gap: space.sm },
  wrap: { flexWrap: 'wrap' },
  muted: { color: colors.muted, fontSize: 13, lineHeight: 19 },
  faint: { color: colors.faint, fontSize: 12, lineHeight: 18 },
  body: { color: colors.softWhite, fontSize: 15, lineHeight: 21 },
  mono: { fontFamily: 'monospace' },
});

const styles = StyleSheet.create({
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    paddingHorizontal: space.lg,
    paddingTop: space.sm,
    paddingBottom: space.md,
  },
  headerMain: { flex: 1, gap: 2 },
  headerRight: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  back: { width: 34, height: 34, alignItems: 'center', justifyContent: 'center', marginLeft: -4 },
  backText: { color: colors.flame, fontSize: 32, lineHeight: 32, marginTop: -4 },
  title: { ...type.title, color: colors.softWhite },
  subtitle: { color: colors.muted, fontSize: 12, lineHeight: 17 },
  card: {
    backgroundColor: colors.surface,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.line,
    padding: space.lg,
    gap: space.sm,
    marginHorizontal: space.lg,
    marginBottom: space.md,
  },
  sectionLabel: {
    ...type.label,
    color: colors.faint,
    paddingHorizontal: space.xl,
    marginTop: space.md,
    marginBottom: space.sm,
  },
  button: {
    minHeight: 46,
    borderRadius: radius.sm,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: space.lg,
    paddingVertical: space.md,
  },
  buttonCompact: { minHeight: 36, paddingVertical: space.sm, paddingHorizontal: space.md },
  buttonFlame: { backgroundColor: colors.flame },
  buttonGhost: { backgroundColor: 'transparent', borderWidth: 1, borderColor: colors.line },
  buttonDanger: { backgroundColor: colors.dangerWash, borderWidth: 1, borderColor: colors.danger },
  buttonPressed: { opacity: 0.78 },
  buttonDisabled: { opacity: 0.4 },
  buttonText: { ...type.body, fontWeight: '700' },
  buttonTextOnFlame: { color: colors.jetBlack },
  buttonTextGhost: { color: colors.softWhite },
  buttonTextDanger: { color: colors.danger },
  pill: {
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: radius.pill,
    backgroundColor: colors.raised,
    borderWidth: 1,
    borderColor: colors.line,
  },
  pillFlame: { backgroundColor: colors.flameWash, borderColor: 'rgba(255,90,31,0.35)' },
  pillDanger: { backgroundColor: colors.dangerWash, borderColor: 'rgba(255,59,48,0.35)' },
  pillText: { color: colors.muted, fontSize: 11, fontWeight: '700', letterSpacing: 0.4 },
  pillTextFlame: { color: colors.flame },
  pillTextDanger: { color: colors.danger },
});
