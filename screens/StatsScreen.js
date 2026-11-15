// screens/StatsScreen.js
// Reading statistics, worked out from the device's own copy of the library. A book box counts for each book read from
// it. A row of choices at the top limits everything to a time period: all time, one year, or a custom range of read
// dates. The "Before Readeez" section holds year counts: how many books someone read in a year before they started
// using the app, which add to the totals and the books-per-year chart.
//
// The headline figures are plain numbers. The rankings are thin horizontal bars with the count written
// beside each one: the labels stay readable on a phone, and the value is there as text so
// nothing depends on judging a bar's length. Each chart is one series in the theme's accent
// colour, and text stays in the normal text colours.

import React, { useMemo, useState } from 'react';
import { Platform, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import Screen from '../components/Screen';
import PeriodPicker from '../components/PeriodPicker';
import { Button, Card, Dialog, Field, Message, SectionTitle } from '../components/ui';
import { useBooks } from '../contexts/BooksContext';
import { useTheme } from '../contexts/ThemeContext';
import { computeStats, parseTally, periodLabel, readYears, tallyYear } from '../lib/bookLogic';

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
 * A ranked bar chart. In: title, rows [{ label, count }], and optionally max (the top of the scale) and format (how to
 * write a value). Draws nothing without data.
 * All bars share one scale, set by the largest count unless max is given, starting from zero.
 */
function Bars({ title, rows, max: fixedMax, format = String }) {
  const { colors } = useTheme();
  if (!rows.length) return null;
  const max = fixedMax ?? Math.max(...rows.map((row) => row.count), 1);
  return (
    <>
      <SectionTitle>{title}</SectionTitle>
      <Card>
        {rows.map((row) => (
          <View key={row.label} style={styles.row} accessible accessibilityLabel={`${row.label}: ${format(row.count)}`}>
            <View style={styles.rowText}>
              <Text style={[styles.rowLabel, { color: colors.text }]} numberOfLines={1}>{row.label}</Text>
              <Text style={[styles.rowCount, { color: colors.muted }]}>{format(row.count)}</Text>
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

/**
 * The "Before Readeez" section: a list of year counts with a way to add, change or remove one.
 * In: counts (the year-count rows, newest year first), onEdit(row or null to add one).
 */
function YearCounts({ counts, onEdit }) {
  const { colors } = useTheme();
  return (
    <>
      <SectionTitle>Before Readeez</SectionTitle>
      <Card>
        <Text style={[styles.explain, { color: colors.muted }]}>
          Read books before you started using Readeez? Add how many you read in a year, and they count in your stats.
        </Text>
        {counts.map((row) => (
          <Pressable
            key={row.id}
            onPress={() => onEdit(row)}
            accessibilityRole="button"
            accessibilityLabel={`${tallyYear(row)}: ${row.tallyCount} books. Change or remove`}
            style={[styles.countRow, { borderColor: colors.border }]}
          >
            <Text style={[styles.rowLabel, { color: colors.text }]}>{tallyYear(row)}</Text>
            <Text style={[styles.rowCount, { color: colors.muted }]}>{row.tallyCount} {row.tallyCount === 1 ? 'book' : 'books'}</Text>
            <Ionicons name="create-outline" size={18} color={colors.muted} />
          </Pressable>
        ))}
        <Button label="Add a year's count" kind="secondary" onPress={() => onEdit(null)} style={styles.addCount} />
      </Card>
    </>
  );
}

/**
 * The dialog for adding or changing a year count.
 * In: editing (the row being changed, null to add one, or undefined when closed), onClose.
 * Side effects: saves or removes the count through BooksContext, which syncs it like a book. Saving a year that already
 * has a count replaces it, since each year has one count.
 */
function YearCountDialog({ editing, onClose }) {
  const { saveYearCount, deleteBook, yearCounts } = useBooks();
  const { colors } = useTheme();
  const visible = editing !== undefined;
  const [year, setYear] = useState('');
  const [count, setCount] = useState('');
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [opened, setOpened] = useState(undefined);

  // Fills the fields each time the dialog opens: from the row being changed, or blank (this year) for a new one.
  if (visible && opened !== editing) {
    setOpened(editing);
    setYear(editing ? String(tallyYear(editing)) : String(new Date().getFullYear()));
    setCount(editing ? String(editing.tallyCount) : '');
    setError(null);
  }
  if (!visible && opened !== undefined) setOpened(undefined);

  const typedYear = Number(year);
  // Saving onto a year that already has a different count would replace it, so the dialog says so before saving.
  const replaces = yearCounts.find((row) => tallyYear(row) === typedYear && row.id !== editing?.id);

  /** Checks and saves. A browser can fail if the server can't be reached, and the message says so. */
  const save = async () => {
    const parsed = parseTally(year, count);
    if (parsed.error) { setError(parsed.error); return; }
    setBusy(true);
    try {
      await saveYearCount(parsed.year, parsed.count);
      // Changing the year of an existing count moves it: the old year's count goes, once the new one is saved.
      if (editing && tallyYear(editing) !== parsed.year) await deleteBook(editing.id);
      onClose();
    } catch (err) {
      setError(Platform.OS === 'web' ? err.message : 'That couldn\'t be saved on this phone. Please try again.');
    } finally {
      setBusy(false);
    }
  };

  /** Removes the count being changed. */
  const remove = async () => {
    setBusy(true);
    try {
      await deleteBook(editing.id);
      onClose();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      visible={visible}
      title={editing ? 'Change year count' : 'Add a year\'s count'}
      confirmLabel="Save"
      onConfirm={save}
      onCancel={onClose}
      busy={busy}
    >
      <View style={styles.dialogFields}>
        <View style={styles.half}>
          <Field label="Year" value={year} onChangeText={(text) => { setYear(text); setError(null); }} keyboardType="number-pad" maxLength={4} placeholder="e.g. 2023" />
        </View>
        <View style={styles.half}>
          <Field label="Books read" value={count} onChangeText={(text) => { setCount(text); setError(null); }} keyboardType="number-pad" maxLength={5} placeholder="e.g. 40" autoFocus={!editing} />
        </View>
      </View>
      {replaces ? <Message kind="info" text={`${typedYear} already has ${replaces.tallyCount}. Saving replaces it.`} /> : null}
      <Text style={[styles.explain, { color: colors.muted }]}>
        Count only books you haven&apos;t added to Readeez, or they&apos;ll be counted twice.
      </Text>
      <Message text={error} />
      {editing ? (
        <Pressable onPress={remove} accessibilityRole="button" style={styles.removeCount} disabled={busy}>
          <Text style={{ color: '#C62828', fontSize: 15 }}>Remove this count</Text>
        </Pressable>
      ) : null}
    </Dialog>
  );
}

/** The stats screen. */
export default function StatsScreen() {
  const { colors } = useTheme();
  const { books, yearCounts } = useBooks();
  // null is all time. See inPeriod in lib/bookLogic.js for the other shapes.
  const [period, setPeriod] = useState(null);
  // The year count being changed: undefined while the dialog is closed, null while adding a new one.
  const [editing, setEditing] = useState(undefined);
  const rows = useMemo(() => [...books, ...yearCounts], [books, yearCounts]);
  const years = useMemo(() => readYears(rows), [rows]);
  const stats = useMemo(() => computeStats(rows, new Date().getFullYear(), period), [rows, period]);

  return (
    <Screen title="Stats" back>
      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        <View style={styles.periods}>
          <PeriodPicker years={years} value={period} onChange={setPeriod} scroll />
        </View>
        <View style={styles.tiles}>
          <Tile label="Books read" value={stats.finished} />
          {/* "This year" says nothing new once a period is chosen, so it shows only for all time. */}
          {period ? null : <Tile label="This year" value={stats.thisYear} />}
          <Tile label="Avg. rating" value={stats.averageRating ? stats.averageRating.toFixed(1) : '–'} />
        </View>
        {period ? (
          <Text style={[styles.summary, { color: colors.muted }]}>{periodLabel(period)}</Text>
        ) : (
          <Text style={[styles.summary, { color: colors.muted }]}>
            {stats.reading} reading now · {stats.want} on your want-to-read list
          </Text>
        )}
        {stats.counted ? (
          <Text style={[styles.summary, { color: colors.muted }]}>
            Includes {stats.counted} {stats.counted === 1 ? 'book' : 'books'} counted before Readeez
          </Text>
        ) : null}
        {/* A single year would draw one lonely bar, so the chart shows only for longer periods. */}
        {period?.year ? null : <Bars title="Books per year" rows={stats.byYear} />}
        <Bars title="Top authors" rows={stats.topAuthors} />
        <Bars title="Top categories" rows={stats.topCategories} />
        {/* Stars run from 1 to 5, so that's the scale, and a lone 3-star category doesn't draw as a full bar. */}
        <Bars title="Category ratings" rows={stats.categoryRatings} max={5} format={(average) => average.toFixed(1)} />
        {stats.finished === 0 ? (
          <Text style={[styles.summary, { color: colors.muted }]}>
            {period ? 'Nothing read in this period.' : 'Finish a book and your stats will appear here.'}
          </Text>
        ) : null}
        <YearCounts counts={yearCounts} onEdit={setEditing} />
      </ScrollView>
      <YearCountDialog editing={editing} onClose={() => setEditing(undefined)} />
    </Screen>
  );
}

const styles = StyleSheet.create({
  content: { padding: 12, paddingBottom: 40 },
  periods: { marginHorizontal: -12, marginBottom: 4 },
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
  explain: { fontSize: 14, lineHeight: 20, marginBottom: 10 },
  countRow: { flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 44, borderTopWidth: 1 },
  addCount: { marginTop: 10 },
  dialogFields: { flexDirection: 'row', gap: 10 },
  half: { flex: 1 },
  removeCount: { minHeight: 44, justifyContent: 'center', alignSelf: 'flex-start' },
});
