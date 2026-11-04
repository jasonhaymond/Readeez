// screens/StatsScreen.js
// Reading statistics, worked out from the phone's own copy of the library. The headline
// figures are plain numbers. The rankings are thin horizontal bars with the count written
// beside each one: the labels stay readable on a phone, and the value is there as text so
// nothing depends on judging a bar's length. Each chart is one series in the theme's accent
// colour, and text stays in the normal text colours.

import React, { useMemo } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import Screen from '../components/Screen';
import { Card, SectionTitle } from '../components/ui';
import { useBooks } from '../contexts/BooksContext';
import { useTheme } from '../contexts/ThemeContext';
import { computeStats } from '../lib/bookLogic';

/** One headline number. In: label and value. */
function Tile({ label, value }) {
  const { colors } = useTheme();
  return (
    <View style={[styles.tile, { backgroundColor: colors.surface, borderColor: colors.border }]}>
      <Text style={[styles.tileValue, { color: colors.text }]}>{value}</Text>
      <Text style={[styles.tileLabel, { color: colors.muted }]}>{label}</Text>
    </View>
  );
}

/**
 * A ranked bar chart. In: title and rows [{ label, count }]. Draws nothing without data.
 * All bars share one scale, set by the largest count, starting from zero.
 */
function Bars({ title, rows }) {
  const { colors } = useTheme();
  if (!rows.length) return null;
  const max = Math.max(...rows.map((row) => row.count), 1);
  return (
    <>
      <SectionTitle>{title}</SectionTitle>
      <Card>
        {rows.map((row) => (
          <View key={row.label} style={styles.row} accessible accessibilityLabel={`${row.label}: ${row.count}`}>
            <View style={styles.rowText}>
              <Text style={[styles.rowLabel, { color: colors.text }]} numberOfLines={1}>{row.label}</Text>
              <Text style={[styles.rowCount, { color: colors.muted }]}>{row.count}</Text>
            </View>
            {/* A zero count (a year with no books) shows an empty track, with no bar. */}
            <View style={[styles.track, { backgroundColor: colors.border }]}>
              {row.count > 0 ? <View style={[styles.bar, { width: `${(row.count / max) * 100}%`, backgroundColor: colors.accent }]} /> : null}
            </View>
          </View>
        ))}
      </Card>
    </>
  );
}

/** The stats screen. */
export default function StatsScreen() {
  const { colors } = useTheme();
  const { books } = useBooks();
  const stats = useMemo(() => computeStats(books), [books]);

  return (
    <Screen title="Stats" back>
      <ScrollView contentContainerStyle={styles.content}>
        <View style={styles.tiles}>
          <Tile label="Finished" value={stats.finished} />
          <Tile label="This year" value={stats.thisYear} />
          <Tile label="Avg. rating" value={stats.averageRating ? stats.averageRating.toFixed(1) : '–'} />
        </View>
        <Text style={[styles.summary, { color: colors.muted }]}>
          {stats.reading} reading now · {stats.want} on your want-to-read list
        </Text>
        <Bars title="Books per year" rows={stats.byYear} />
        <Bars title="Top authors" rows={stats.topAuthors} />
        <Bars title="Top categories" rows={stats.topCategories} />
        {stats.finished === 0 ? (
          <Text style={[styles.summary, { color: colors.muted }]}>Finish a book and your stats will appear here.</Text>
        ) : null}
      </ScrollView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  content: { padding: 12, paddingBottom: 40 },
  tiles: { flexDirection: 'row', gap: 8, marginBottom: 10 },
  tile: { flex: 1, borderWidth: 1, borderRadius: 12, padding: 12, alignItems: 'center' },
  tileValue: { fontSize: 26, fontWeight: '700' },
  tileLabel: { fontSize: 12, marginTop: 2 },
  summary: { fontSize: 14, textAlign: 'center', marginVertical: 8 },
  row: { marginBottom: 12 },
  rowText: { flexDirection: 'row', justifyContent: 'space-between', gap: 12, marginBottom: 4 },
  rowLabel: { fontSize: 14, flex: 1 },
  rowCount: { fontSize: 14, fontVariant: ['tabular-nums'] },
  track: { height: 6, borderRadius: 4, overflow: 'hidden' },
  bar: { height: 6, borderRadius: 4 },
});
