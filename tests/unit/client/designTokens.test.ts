import { describe, expect, it } from 'vitest';
import { applyClientDesignTokens, clientStyleProperties } from '../../../src/client/applyDesignTokens';
import { clientDesign } from '../../../src/client/designTokens';

function contrastRatio(foreground: string, background: string): number {
  const luminance = (color: string) => {
    const channels = color.match(/[\da-f]{2}/gi)?.map((channel) => parseInt(channel, 16) / 255);
    if (!channels || channels.length !== 3) throw new Error(`Invalid hex color: ${color}`);
    const [red, green, blue] = channels.map((channel) => (
      channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4
    ));
    return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
  };

  const values = [luminance(foreground), luminance(background)].sort((first, second) => second - first);
  return (values[0] + 0.05) / (values[1] + 0.05);
}

describe('client design decisions', () => {
  it('limits initial locale support to English and German', () => {
    expect(clientDesign.locale).toEqual({ default: 'en', supported: ['en', 'de'] });
  });

  it('uses Heilbronn as the only initial map city', () => {
    expect(clientDesign.map).toEqual({
      cityId: 'heilbronn',
      center: { latitude: 49.14, longitude: 9.22 },
      zoom: 13,
    });
  });

  it('keeps concept-derived visual tokens provisional and readable', () => {
    const { colors } = clientDesign.visual;

    expect(clientDesign.visual.status).toBe('provisional');
    expect(contrastRatio(colors.text, colors.canvas)).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(colors.textMuted, colors.canvas)).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(colors.brandText, colors.brand)).toBeGreaterThanOrEqual(4.5);
    for (const surface of [colors.canvas, colors.surface, colors.surfaceMuted]) {
      expect(contrastRatio(colors.border, surface)).toBeGreaterThanOrEqual(3);
    }

    for (const route of Object.values(colors.route)) {
      expect(contrastRatio(route.text, route.surface)).toBeGreaterThanOrEqual(4.5);
      for (const surface of [colors.canvas, colors.surface, colors.surfaceMuted]) {
        expect(contrastRatio(route.marker, surface)).toBeGreaterThanOrEqual(3);
      }
    }
  });

  it('applies the design tokens as client CSS properties', () => {
    const applied: Array<[string, string]> = [];

    applyClientDesignTokens({
      setProperty(property, value) {
        if (value) applied.push([property, value]);
      },
    });

    expect(Object.fromEntries(applied)).toEqual(clientStyleProperties);
  });
});
