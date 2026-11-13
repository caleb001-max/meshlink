/**
 * MeshLink visual system: jet black, soft white, flame orange.
 * Every screen imports these tokens so the palette stays consistent.
 */

export const colors = {
  /** Page background. */
  jetBlack: '#050506',
  /** Cards and inputs. */
  surface: '#101013',
  /** Raised elements (buttons, chips). */
  raised: '#17171B',
  /** Hairlines and borders. */
  line: '#26262C',
  /** Primary text. */
  softWhite: '#F4F0E8',
  /** Secondary text. */
  muted: '#A6A099',
  /** Tertiary text / timestamps. */
  faint: '#6E6962',
  /** Accent: actions, sent bubbles, active state. */
  flame: '#FF5A1F',
  /** Pressed accent. */
  flameDeep: '#D9480F',
  /** Accent wash for selected chips and banners. */
  flameWash: 'rgba(255, 90, 31, 0.14)',
  /** Destructive actions only. */
  danger: '#FF3B30',
  /** Destructive wash. */
  dangerWash: 'rgba(255, 59, 48, 0.12)',
  /** Modal scrim. */
  scrim: 'rgba(0, 0, 0, 0.72)',
} as const;

export const radius = {
  sm: 10,
  md: 14,
  lg: 20,
  pill: 999,
} as const;

export const space = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 24,
  xxl: 32,
} as const;

export const type = {
  display: { fontSize: 34, fontWeight: '800' as const, letterSpacing: -0.5 },
  title: { fontSize: 24, fontWeight: '800' as const, letterSpacing: -0.3 },
  heading: { fontSize: 18, fontWeight: '700' as const },
  body: { fontSize: 15, fontWeight: '400' as const },
  label: { fontSize: 12, fontWeight: '700' as const, letterSpacing: 1.2 },
  caption: { fontSize: 12, fontWeight: '400' as const },
} as const;

/** Shared elevation-free card look (dark UI reads better flat). */
export const card = {
  backgroundColor: colors.surface,
  borderRadius: radius.md,
  borderWidth: 1,
  borderColor: colors.line,
} as const;
