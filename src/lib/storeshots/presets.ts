import type { StyleRules } from './types'

/**
 * The style presets the studio ships: neutral looks to start from. A repo adds its own under
 * `shots.presets` in `kit.config.ts`; one with the same name replaces the built-in. Browser-safe:
 * the editor imports this file.
 */
export const BUILT_IN_PRESETS: Record<string, StyleRules> = {
  light: {
    headline: { color: '#111111' },
    subheadline: { color: '#555555' },
    badge: {
      backgroundColor: 'rgba(0, 0, 0, 0.06)',
      textColor: '#333333',
      borderColor: 'rgba(0, 0, 0, 0.15)',
    },
    background: {
      type: 'linear-gradient',
      primaryColor: '#ffffff',
      secondaryColor: '#eeeeee',
      accentColor: '#888888',
      angle: 180,
    },
  },
  dark: {
    headline: { color: '#ffffff' },
    subheadline: { color: '#c4c4c8' },
    badge: {
      backgroundColor: 'rgba(255, 255, 255, 0.12)',
      textColor: '#f2f2f4',
      borderColor: 'rgba(255, 255, 255, 0.25)',
    },
    background: {
      type: 'linear-gradient',
      primaryColor: '#1c1c22',
      secondaryColor: '#0a0a0d',
      accentColor: '#3a3a46',
      angle: 180,
    },
  },
  'bold-colour': {
    headline: { color: '#ffffff', fontWeight: 900 },
    subheadline: { color: '#e8eaff' },
    badge: {
      backgroundColor: 'rgba(255, 255, 255, 0.2)',
      textColor: '#ffffff',
      borderColor: 'rgba(255, 255, 255, 0.4)',
    },
    background: {
      type: 'linear-gradient',
      primaryColor: '#4f46e5',
      secondaryColor: '#7c3aed',
      accentColor: '#22d3ee',
      angle: 160,
    },
  },
}
