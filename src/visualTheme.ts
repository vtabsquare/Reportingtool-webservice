export const DARK_REPORT_THEME = {
  canvas: '#070b14',
  surface: '#101827',
  surfaceRaised: '#162033',
  surfaceAlternate: '#0c1422',
  border: '#334155',
  grid: 'rgba(148, 163, 184, 0.14)',
  text: '#f8fafc',
  mutedText: '#cbd5e1',
  subtleText: '#94a3b8',
  tooltip: '#111827',
  accent: '#38bdf8'
} as const;

type Rgb = { r: number; g: number; b: number; a: number };

function parseColor(value?: string): Rgb | null {
  if (!value) return null;
  const color = value.trim().toLowerCase();
  if (color === 'transparent') return { r: 0, g: 0, b: 0, a: 0 };
  const short = color.match(/^#([0-9a-f]{3,4})$/i);
  if (short) {
    const chars = short[1].split('').map(char => char + char);
    return { r: parseInt(chars[0], 16), g: parseInt(chars[1], 16), b: parseInt(chars[2], 16), a: chars[3] ? parseInt(chars[3], 16) / 255 : 1 };
  }
  const full = color.match(/^#([0-9a-f]{6})([0-9a-f]{2})?$/i);
  if (full) return { r: parseInt(full[1].slice(0, 2), 16), g: parseInt(full[1].slice(2, 4), 16), b: parseInt(full[1].slice(4, 6), 16), a: full[2] ? parseInt(full[2], 16) / 255 : 1 };
  const rgb = color.match(/^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:\s*[,/]\s*([\d.]+%?))?\s*\)$/i);
  if (!rgb) return null;
  const alpha = rgb[4] ? (rgb[4].endsWith('%') ? parseFloat(rgb[4]) / 100 : parseFloat(rgb[4])) : 1;
  return { r: Math.min(255, +rgb[1]), g: Math.min(255, +rgb[2]), b: Math.min(255, +rgb[3]), a: Math.max(0, Math.min(1, alpha)) };
}

function luminance(value?: string): number | null {
  const rgb = parseColor(value);
  if (!rgb || rgb.a < 0.05) return null;
  const channel = (n: number) => { const s = n / 255; return s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4); };
  return 0.2126 * channel(rgb.r) + 0.7152 * channel(rgb.g) + 0.0722 * channel(rgb.b);
}

export function contrastRatio(foreground?: string, background?: string): number {
  const a = luminance(foreground), b = luminance(background);
  if (a === null || b === null) return 1;
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

export function isColorDark(value?: string): boolean {
  const result = luminance(value);
  return result !== null && result < 0.18;
}

export function isColorLight(value?: string): boolean {
  const result = luminance(value);
  return result !== null && result > 0.72;
}

export function resolveDarkSurface(value: string | undefined, fallback = DARK_REPORT_THEME.surface): string {
  if (!value || value.trim().toLowerCase() === 'transparent') return fallback;
  return isColorLight(value) ? fallback : value;
}

export function resolveDarkText(value: string | undefined, background = DARK_REPORT_THEME.surface, fallback = DARK_REPORT_THEME.text): string {
  if (!value || isColorDark(value) || contrastRatio(value, background) < 3.5) return fallback;
  return value;
}

export function resolveDarkBorder(value: string | undefined, background = DARK_REPORT_THEME.surface): string {
  if (!value || isColorLight(value) || contrastRatio(value, background) < 1.35) return DARK_REPORT_THEME.border;
  return value;
}
