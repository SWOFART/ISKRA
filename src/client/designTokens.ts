export const clientDesign = {
  locale: {
    default: 'en',
    supported: ['en', 'de'],
  },
  map: {
    cityId: 'heilbronn',
    center: { latitude: 49.14, longitude: 9.22 },
    zoom: 13,
  },
  visual: {
    status: 'provisional',
    colors: {
      canvas: '#F5F7F2',
      surface: '#FFFFFF',
      surfaceMuted: '#EAF1EB',
      text: '#1C2B21',
      textMuted: '#526059',
      border: '#D5DED7',
      brand: '#176B4D',
      brandText: '#FFFFFF',
      focus: '#145D42',
      route: {
        green: { marker: '#2E8055', surface: '#E7F1E9', text: '#245D3B' },
        yellow: { marker: '#D19A1E', surface: '#FFF0BF', text: '#6A4B00' },
        red: { marker: '#C54840', surface: '#FBE6E4', text: '#8F2822' },
      },
    },
    radius: {
      control: '0.75rem',
      card: '1rem',
      sheet: '1.25rem',
      pill: '999px',
    },
  },
} as const;

export type SupportedLocale = (typeof clientDesign.locale.supported)[number];
