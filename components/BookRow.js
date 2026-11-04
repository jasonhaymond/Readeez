// components/BookRow.js
// One book in a list (the library and search results): title, authors, rating and
// date. Tapping it opens the book.

import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useNavigation } from '@react-navigation/native';
import { Stars } from './ui';
import { useTheme } from '../contexts/ThemeContext';
import { formatDate } from '../lib/bookLogic';

const STATUS_TEXT = { reading: 'Reading', want: 'Want to read' };

/**
 * Draws the row. In: book. The status appears as text only when it isn't "finished", the
 * usual case, to keep the list uncluttered. Book text is drawn with native Text, which
 * never runs it as code, whatever a title or note contains.
 */
export default function BookRow({ book }) {
  const navigation = useNavigation();
  const { colors } = useTheme();
  const status = STATUS_TEXT[book.status];
  return (
    <Pressable
      onPress={() => navigation.navigate('Book', { id: book.id })}
      accessibilityRole="button"
      style={({ pressed }) => [styles.row, { backgroundColor: colors.surface, borderColor: colors.border, opacity: pressed ? 0.75 : 1 }]}
    >
      <Text style={[styles.title, { color: colors.text }]} numberOfLines={2}>{book.title}</Text>
      {book.authors.length ? (
        <Text style={[styles.authors, { color: colors.muted }]} numberOfLines={1}>{book.authors.join(', ')}</Text>
      ) : null}
      <View style={styles.meta}>
        {book.rating ? <Stars value={book.rating} size={14} /> : null}
        <Text style={[styles.date, { color: colors.muted }]} numberOfLines={1}>{status || formatDate(book.readDate)}</Text>
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  row: { borderWidth: 1, borderRadius: 12, paddingHorizontal: 14, paddingVertical: 12, marginBottom: 8 },
  title: { fontSize: 16, fontWeight: '600' },
  authors: { fontSize: 14, marginTop: 2 },
  meta: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: 6, gap: 12, minHeight: 16 },
  date: { fontSize: 13, flexShrink: 1, marginLeft: 'auto' },
});
