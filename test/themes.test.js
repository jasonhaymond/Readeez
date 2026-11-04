// test/themes.test.js
// Checks that every theme stays readable in light and dark mode, by computing the WCAG
// contrast ratio (the standard measure of text legibility). A new theme gets this check
// automatically.

const { THEMES } = require('../constants/themes');

/**
 * Relative brightness of a colour, by the WCAG formula.
 * In: '#RRGGBB'. Out: 0 (black) to 1 (white).
 */
function luminance(hex) {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** The contrast ratio of two colours, from 1 to 21. */
function contrast(a, b) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

const cases = THEMES.flatMap((theme) => ['light', 'dark'].map((mode) => [theme.id, mode, theme]));

describe.each(cases)('%s (%s)', (id, mode, theme) => {
  const colors = theme[mode];
  // Gradient themes must stay readable at both ends of the gradient, as well as on `bg`.
  const backgrounds = [colors.bg, ...(theme[`${mode}Gradient`] || [])];

  // Normal text needs 4.5:1 under WCAG AA.
  test('text is readable on cards and backgrounds', () => {
    [colors.surface, ...backgrounds].forEach((bg) => {
      expect(contrast(colors.text, bg)).toBeGreaterThanOrEqual(4.5);
      expect(contrast(colors.muted, bg)).toBeGreaterThanOrEqual(4.5);
    });
  });

  test('button text is readable on the accent colour', () => {
    expect(contrast(colors.onAccent, colors.accent)).toBeGreaterThanOrEqual(4.5);
  });

  // Icons and stars need 3:1 under WCAG AA.
  test('the accent colour is visible on cards and backgrounds', () => {
    [colors.surface, ...backgrounds].forEach((bg) => {
      expect(contrast(colors.accent, bg)).toBeGreaterThanOrEqual(3);
    });
  });
});
