// screens/SearchScreen.js
// Global search across titles, authors, categories and notes. It searches the phone's own
// copy of the library, so results appear as each letter is typed, and work offline.

import React, { useMemo, useState } from 'react';
import { FlatList, StyleSheet, Text, View } from 'react-native';
import Screen from '../components/Screen';
import BookRow from '../components/BookRow';
import { Field } from '../components/ui';
import { useBooks } from '../contexts/BooksContext';
import { useTheme } from '../contexts/ThemeContext';
import { searchBooks } from '../lib/bookLogic';

/** The search screen. The keyboard opens straight away, ready to type. */
export default function SearchScreen() {
  const { colors } = useTheme();
  const { books } = useBooks();
  const [query, setQuery] = useState('');
  const results = useMemo(() => searchBooks(books, query), [books, query]);

  return (
    <Screen title="Search" back>
      <View style={styles.box}>
        <Field value={query} onChangeText={setQuery} placeholder="Title, author, category or notes" autoFocus returnKeyType="search" accessibilityLabel="Search all books" />
      </View>
      <FlatList
        data={results}
        keyExtractor={(book) => book.id}
        renderItem={({ item }) => <BookRow book={item} />}
        contentContainerStyle={styles.list}
        keyboardShouldPersistTaps="handled"
        ListEmptyComponent={query.trim() ? <Text style={[styles.none, { color: colors.muted }]}>No books found.</Text> : null}
      />
    </Screen>
  );
}

const styles = StyleSheet.create({
  box: { paddingHorizontal: 12 },
  list: { paddingHorizontal: 12, paddingBottom: 32 },
  none: { textAlign: 'center', marginTop: 28, fontSize: 15 },
});
