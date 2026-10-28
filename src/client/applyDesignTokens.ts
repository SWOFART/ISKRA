import { clientDesign } from './designTokens';

const colors = clientDesign.visual.colors;

export const clientStyleProperties = {
  '--client-color-canvas': colors.canvas,
  '--client-color-surface': colors.surface,
  '--client-color-surface-muted': colors.surfaceMuted,
  '--client-color-text': colors.text,
  '--client-color-text-muted': colors.textMuted,
  '--client-color-border': colors.border,
  '--client-color-brand': colors.brand,
  '--client-color-brand-text': colors.brandText,
  '--client-color-focus': colors.focus,
  '--client-route-green-marker': colors.route.green.marker,
  '--client-route-green-surface': colors.route.green.surface,
  '--client-route-green-text': colors.route.green.text,
  '--client-route-yellow-marker': colors.route.yellow.marker,
  '--client-route-yellow-surface': colors.route.yellow.surface,
  '--client-route-yellow-text': colors.route.yellow.text,
  '--client-route-red-marker': colors.route.red.marker,
  '--client-route-red-surface': colors.route.red.surface,
  '--client-route-red-text': colors.route.red.text,
  '--client-radius-control': clientDesign.visual.radius.control,
  '--client-radius-card': clientDesign.visual.radius.card,
  '--client-radius-sheet': clientDesign.visual.radius.sheet,
  '--client-radius-pill': clientDesign.visual.radius.pill,
} as const;

export function applyClientDesignTokens(style: Pick<CSSStyleDeclaration, 'setProperty'>): void {
  for (const [property, value] of Object.entries(clientStyleProperties)) {
    style.setProperty(property, value);
  }
}
