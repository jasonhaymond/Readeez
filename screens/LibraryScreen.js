// screens/LibraryScreen.js
// The home screen: every book, most recently read first, with a status filter and an
// optional filter by author, category or rating. Pulling down syncs with the server.

import React, { useMemo, useState } from 'react';
import { FlatList, Modal, Platform, Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useNavigation } from '@react-navigation/native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Ionicons from '@expo/vector-icons/Ionicons';
import Screen from '../components/Screen';
import BookRow from '../components/BookRow';
import { Button, Chip, Message, SectionTitle, Stars } from '../components/ui';
import { useBooks } from '../contexts/BooksContext';
import { useTheme } from '../contexts/ThemeContext';
import { distinctNames, filterBooks } from '../lib/bookLogic';

const STATUS_FILTERS = [
  { id: null, label: 'All' },
  { id: 'reading', label: 'Reading' },
  { id: 'want', label: 'Want to read' },
  { id: 'finished', label: 'Finished' },
];

/** The library screen. */
export default function LibraryScreen() {
  const navigation = useNavigation();
  const { colors } = useTheme();
  const { books, ready, sync, syncNow, pendingCount } = useBooks();
  const [status, setStatus] = useState(null);
  const [filters, setFilters] = useState({ author: null, category: null, rating: null });
  const [filterOpen, setFilterOpen] = useState(false);

  const shown = useMemo(() => filterBooks(books, { status, ...filters }), [books, status, filters]);
  const activeFilters = [filters.author, filters.category, filters.rating !== null ? 'rating' : null].filter(Boolean).length;

  // A problem shows above the list, because adding a book mustn't hide it. A browser that couldn't download the library
  // has nothing to show yet, so "offline" counts as a problem there. On a phone it's normal, and its books are all there.
  const problem = sync.state === 'error' || (!ready && sync.state === 'offline') ? sync.message : null;

  // A quiet note appears only when something's worth knowing: books waiting to sync.
  const syncNote = pendingCount > 0 && sync.state !== 'syncing'
    ? `${pendingCount} ${pendingCount === 1 ? 'change' : 'changes'} waiting to sync`
    : null;

  return (
    <Screen title="Readeez" logo>
      <View style={styles.filterBar}>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chips} keyboardShouldPersistTaps="handled">
          <Chip label={activeFilters ? `Filter (${activeFilters})` : 'Filter'} icon="options-outline" selected={activeFilters > 0} onPress={() => setFilterOpen(true)} />
          {STATUS_FILTERS.map((option) => (
            <Chip key={option.label} label={option.label} selected={status === option.id} onPress={() => setStatus(option.id)} />
          ))}
        </ScrollView>
      </View>
      {syncNote ? (
        <View style={styles.note}>
          <Ionicons name="cloud-upload-outline" size={14} color={colors.muted} />
          <Text style={{ color: colors.muted, fontSize: 13 }}>{syncNote}</Text>
        </View>
      ) : null}
      {problem ? (
        <View style={styles.problem}>
          <Message text={problem} />
          {/* Only a browser can be retried from here. A phone that can't read its own storage needs a restart, as it says. */}
          {!ready && Platform.OS === 'web' ? <Button label="Try again" kind="secondary" onPress={syncNow} /> : null}
        </View>
      ) : null}
      <FlatList
        data={shown}
        keyExtractor={(book) => book.id}
        renderItem={({ item }) => <BookRow book={item} />}
        contentContainerStyle={styles.list}
        keyboardShouldPersistTaps="handled"
        refreshControl={<RefreshControl refreshing={sync.state === 'syncing'} onRefresh={syncNow} colors={[colors.accent]} tintColor={colors.accent} />}
        ListEmptyComponent={ready ? (
          <EmptyState
            hasBooks={books.length > 0}
            onAdd={() => navigation.navigate('Book')}
            onClear={() => { setStatus(null); setFilters({ author: null, category: null, rating: null }); }}
          />
        ) : null}
      />
      <FilterSheet visible={filterOpen} books={books} filters={filters} onChange={setFilters} onClose={() => setFilterOpen(false)} />
    </Screen>
  );
}

/**
 * Shown when the list is empty: an invitation for a new library, or a way out of filters
 * that match nothing. In: hasBooks, onAdd, onClear.
 */
function EmptyState({ hasBooks, onAdd, onClear }) {
  const { colors } = useTheme();
  return (
    <View style={styles.empty}>
      <Ionicons name={hasBooks ? 'filter-outline' : 'book-outline'} size={44} color={colors.muted} />
      <Text style={[styles.emptyTitle, { color: colors.text }]}>{hasBooks ? 'No books match' : 'Your library is empty'}</Text>
      <Text style={[styles.emptyText, { color: colors.muted }]}>
        {hasBooks ? 'Try clearing the filters.' : 'Add the book you just finished, or the one you\'re reading now.'}
      </Text>
      {hasBooks ? <Button label="Clear filters" kind="secondary" onPress={onClear} /> : <Button label="Add a book" onPress={onAdd} />}
    </View>
  );
}

/**
 * The sheet that slides up to filter by author, category and rating.
 * In: visible, books (the choices come from what's in the library), filters, onChange, onClose.
 */
function FilterSheet({ visible, books, filters, onChange, onClose }) {
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const authors = useMemo(() => distinctNames(books, 'authors'), [books]);
  const categories = useMemo(() => distinctNames(books, 'categories'), [books]);
  const toggle = (field, value) => onChange({ ...filters, [field]: filters[field] === value ? null : value });

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <Pressable style={styles.sheetBackdrop} onPress={onClose} accessibilityLabel="Close filters" />
      <View style={[styles.sheet, { backgroundColor: colors.surface, borderColor: colors.border, paddingBottom: insets.bottom + 14 }]}>
        <ScrollView>
          <SectionTitle>Rating</SectionTitle>
          <View style={styles.wrapChips}>
            {[5, 4, 3, 2, 1].map((n) => (
              <Pressable
                key={n}
                onPress={() => toggle('rating', n)}
                accessibilityRole="button"
                accessibilityState={{ selected: filters.rating === n }}
                aria-pressed={filters.rating === n}
                style={[styles.ratingChoice, { borderColor: filters.rating === n ? colors.accent : colors.border }]}
              >
                <Stars value={n} size={13} />
              </Pressable>
            ))}
            <Chip label="Not rated" selected={filters.rating === 0} onPress={() => toggle('rating', 0)} />
          </View>
          {categories.length ? <SectionTitle>Category</SectionTitle> : null}
          <View style={styles.wrapChips}>
            {categories.map((name) => <Chip key={name} label={name} selected={filters.category === name} onPress={() => toggle('category', name)} />)}
          </View>
          {authors.length ? <SectionTitle>Author</SectionTitle> : null}
          <View style={styles.wrapChips}>
            {authors.map((name) => <Chip key={name} label={name} selected={filters.author === name} onPress={() => toggle('author', name)} />)}
          </View>
        </ScrollView>
        <View style={styles.sheetButtons}>
          <Button label="Clear" kind="secondary" style={styles.sheetButton} onPress={() => onChange({ author: null, category: null, rating: null })} />
          <Button label="Done" style={styles.sheetButton} onPress={onClose} />
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  filterBar: { flexGrow: 0 },
  chips: { paddingHorizontal: 12, paddingBottom: 8, gap: 6, alignItems: 'center' },
  problem: { paddingHorizontal: 16, paddingBottom: 8 },
  note: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 16, paddingBottom: 6 },
  list: { paddingHorizontal: 12, paddingBottom: 32, flexGrow: 1 },
  empty: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 32, gap: 10 },
  emptyTitle: { fontSize: 18, fontWeight: '600', marginTop: 6 },
  emptyText: { fontSize: 15, textAlign: 'center', marginBottom: 10 },
  sheetBackdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.4)' },
  sheet: { maxHeight: '75%', borderTopLeftRadius: 18, borderTopRightRadius: 18, borderWidth: 1, paddingHorizontal: 16, paddingTop: 8 },
  wrapChips: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginBottom: 6 },
  ratingChoice: { borderWidth: 1, borderRadius: 18, minHeight: 36, justifyContent: 'center', paddingHorizontal: 10 },
  sheetButtons: { flexDirection: 'row', gap: 10, marginTop: 12 },
  sheetButton: { flex: 1 },
});
