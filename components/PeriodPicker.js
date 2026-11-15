// components/PeriodPicker.js
// Chooses a time period by read date: all time, one year, or a custom range of dates. Used by the library's filter
// sheet and the Stats screen, so both offer the same choices. The period itself is described in lib/bookLogic.js
// (see inPeriod), and this only draws the choices and reports what was picked.

import React, { useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import DateField from './DateField';
import { Chip, Message } from './ui';
import { useTheme } from '../contexts/ThemeContext';
import { periodProblem } from '../lib/bookLogic';

/**
 * Draws the choices.
 * In: years (the years something was read in, newest first), value (the current period, or null for all time),
 * onChange(period), and optionally scroll: true lays the chips out in one sideways-scrolling row, for the top of a
 * screen, instead of wrapping them.
 * A custom range with neither date set yet reports null (all time), so choosing "Custom range" doesn't hide every
 * book without a read date before any date has been picked. Either end can be left empty, meaning "since" or "until".
 */
export default function PeriodPicker({ years, value, onChange, scroll = false }) {
  const { colors } = useTheme();
  // Remembers that "Custom range" was chosen while no date is set yet, because the period is still null then.
  const [customChosen, setCustomChosen] = useState(false);
  const isRange = Boolean(value && !value.year);
  const custom = isRange || (customChosen && !value);
  const range = isRange ? value : { from: null, to: null };

  /** Changes one end of the range. In: { from } or { to }. Reports null once both ends are empty again. */
  const setRange = (changes) => {
    const next = { ...range, ...changes };
    onChange(next.from || next.to ? next : null);
  };
  /** Picks all time or one year, leaving custom-range mode. In: null or a year. */
  const pick = (year) => {
    setCustomChosen(false);
    onChange(year ? { year } : null);
  };

  const chips = (
    <>
      <Chip label="All time" selected={!value && !custom} onPress={() => pick(null)} />
      {years.map((year) => <Chip key={year} label={String(year)} selected={value?.year === year} onPress={() => pick(year)} />)}
      <Chip label="Custom range" icon="calendar-outline" selected={custom} onPress={() => { setCustomChosen(true); if (value?.year) onChange(null); }} />
    </>
  );

  return (
    <View>
      {scroll ? (
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.row} keyboardShouldPersistTaps="handled">
          {chips}
        </ScrollView>
      ) : (
        <View style={styles.wrap}>{chips}</View>
      )}
      {custom ? (
        <View style={[styles.range, scroll && styles.rangePadded]}>
          <View style={styles.dates}>
            <View style={styles.half}><DateField label="From" value={range.from} onChange={(from) => setRange({ from })} /></View>
            <View style={styles.half}><DateField label="To" value={range.to} onChange={(to) => setRange({ to })} /></View>
          </View>
          {/* The phone's date picker can't be emptied, so this clears both ends. */}
          {range.from || range.to ? (
            <Pressable onPress={() => onChange(null)} accessibilityRole="button" style={styles.clear}>
              <Text style={{ color: colors.accent, fontSize: 14 }}>Clear dates</Text>
            </Pressable>
          ) : null}
          <Message text={periodProblem(value)} />
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  row: { paddingHorizontal: 12, paddingBottom: 8, gap: 6, alignItems: 'center' },
  wrap: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginBottom: 6 },
  range: { marginTop: 4 },
  rangePadded: { paddingHorizontal: 12 },
  dates: { flexDirection: 'row', gap: 10 },
  half: { flex: 1 },
  clear: { minHeight: 36, justifyContent: 'center', alignSelf: 'flex-start', marginTop: -6 },
});
