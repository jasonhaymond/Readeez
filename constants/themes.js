// constants/themes.js
// The look of the app. A theme gives a light and a dark version of its colours, and
// 'gradient' themes add a soft background gradient. To add a theme, add an entry here;
// Settings lists whatever is in this array. Image backgrounds would be a new `kind`.
//
// Written as a plain module so the test suite can load it directly.
//
// Each colour set must keep text readable on `surface` and on the page background
// (test/themes.test.js checks contrast for every theme in both modes).

/**
 * Builds a full colour set from the few values that differ between themes.
 * In: accent (buttons, stars), onAccent (text on the accent), bg (page), surface (cards),
 * text, muted (secondary text), border. Out: the colours object screens use.
 */
const colors = (accent, onAccent, bg, surface, text, muted, border) => ({ accent, onAccent, bg, surface, text, muted, border });

const LIGHT_NEUTRAL = { text: '#1F2328', muted: '#5A626B', border: '#DADDE1' };
const DARK_NEUTRAL = { text: '#ECEEF0', muted: '#A8B0B8', border: '#3A4047' };

const THEMES = [
  {
    id: 'paper', name: 'Paper', kind: 'solid',
    light: colors('#9A5B13', '#FFFFFF', '#F8F4EC', '#FFFDF9', LIGHT_NEUTRAL.text, '#635B50', '#E2DACB'),
    dark: colors('#E0A458', '#231708', '#1B1815', '#27231E', DARK_NEUTRAL.text, '#B5AC9F', '#3F382F'),
  },
  {
    id: 'forest', name: 'Forest', kind: 'solid',
    light: colors('#2B6E4F', '#FFFFFF', '#F2F6F2', '#FFFFFF', LIGHT_NEUTRAL.text, LIGHT_NEUTRAL.muted, '#D5DFD7'),
    dark: colors('#6CC49B', '#0D2118', '#141A17', '#1E2622', DARK_NEUTRAL.text, DARK_NEUTRAL.muted, '#34403A'),
  },
  {
    id: 'ocean', name: 'Ocean', kind: 'solid',
    light: colors('#1F6390', '#FFFFFF', '#F1F5F8', '#FFFFFF', LIGHT_NEUTRAL.text, LIGHT_NEUTRAL.muted, '#D3DEE6'),
    dark: colors('#6DB6E3', '#0A2233', '#12181D', '#1C242B', DARK_NEUTRAL.text, DARK_NEUTRAL.muted, '#323E48'),
  },
  {
    id: 'plum', name: 'Plum', kind: 'solid',
    light: colors('#74408F', '#FFFFFF', '#F7F3F9', '#FFFFFF', LIGHT_NEUTRAL.text, LIGHT_NEUTRAL.muted, '#E2D8E8'),
    dark: colors('#C698DF', '#2A1137', '#1A151D', '#251E2A', DARK_NEUTRAL.text, DARK_NEUTRAL.muted, '#3F3546'),
  },
  {
    id: 'slate', name: 'Slate', kind: 'solid',
    light: colors('#46535F', '#FFFFFF', '#F3F4F6', '#FFFFFF', LIGHT_NEUTRAL.text, LIGHT_NEUTRAL.muted, LIGHT_NEUTRAL.border),
    dark: colors('#AEBBC7', '#1A2128', '#15181B', '#1F2327', DARK_NEUTRAL.text, DARK_NEUTRAL.muted, DARK_NEUTRAL.border),
  },
  {
    id: 'sunrise', name: 'Sunrise', kind: 'gradient',
    lightGradient: ['#FDE8D3', '#FBD9DC'],
    darkGradient: ['#2E1B22', '#3A2218'],
    light: colors('#A8431F', '#FFFFFF', '#FDE8D3', '#FFFAF6', LIGHT_NEUTRAL.text, '#65564F', '#EBD5CB'),
    dark: colors('#F2A07B', '#2C1208', '#2E1B22', '#3A2A2C', DARK_NEUTRAL.text, '#C2B3AE', '#54403F'),
  },
  {
    id: 'dusk', name: 'Dusk', kind: 'gradient',
    lightGradient: ['#E3E2F8', '#F4DDEE'],
    darkGradient: ['#191A38', '#33193A'],
    light: colors('#5B47A8', '#FFFFFF', '#E3E2F8', '#FBFAFF', LIGHT_NEUTRAL.text, '#5A5870', '#D9D5EC'),
    dark: colors('#B5A7F2', '#1B1242', '#191A38', '#2A2A4A', DARK_NEUTRAL.text, '#B4B2CB', '#444464'),
  },
  {
    id: 'aurora', name: 'Aurora', kind: 'gradient',
    lightGradient: ['#D8F2EC', '#DCE6FA'],
    darkGradient: ['#0F2A2C', '#162040'],
    light: colors('#16716C', '#FFFFFF', '#D8F2EC', '#F8FDFC', LIGHT_NEUTRAL.text, '#4F6467', '#CBE0DF'),
    dark: colors('#6ED6C8', '#07272A', '#0F2A2C', '#1D3438', DARK_NEUTRAL.text, '#A6BDBF', '#37504F'),
  },
  {
    id: 'meadow', name: 'Meadow', kind: 'gradient',
    lightGradient: ['#EEF3CF', '#D7EFD8'],
    darkGradient: ['#20280F', '#102A1B'],
    light: colors('#4F6D1E', '#FFFFFF', '#EEF3CF', '#FCFDF4', LIGHT_NEUTRAL.text, '#5B6350', '#DCE3C5'),
    dark: colors('#B5D56F', '#1C2606', '#20280F', '#2E3620', DARK_NEUTRAL.text, '#B5BCA5', '#454F35'),
  },
];

const DEFAULT_THEME_ID = 'paper';
const MODES = [
  { id: 'system', label: 'System' },
  { id: 'light', label: 'Light' },
  { id: 'dark', label: 'Dark' },
];

module.exports = { THEMES, DEFAULT_THEME_ID, MODES };
