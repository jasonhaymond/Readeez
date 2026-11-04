// screens/BookScreen.js
// Adding and editing a book, on one form. It's opened with no id to add (the + button,
// with the title field ready to type) or with a book's id to view and edit it. Everything
// is optional except the title, and the read date defaults to today.

import React, { useMemo, useRef, useState } from 'react';
import { KeyboardAvoidingView, ScrollView, StyleSheet, View } from 'react-native';
import { useNavigation, useRoute } from '@react-navigation/native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Screen from '../components/Screen';
import NamePicker from '../components/NamePicker';
import DateField from '../components/DateField';
import { Button, Dialog, Field, Message, Segmented, SectionTitle, Stars } from '../components/ui';
import { useBooks } from '../contexts/BooksContext';
import { distinctNames, emptyBook, readDateForStatus, STATUSES } from '../lib/bookLogic';

// Matches the limits the server enforces (server/bookValidation.js).
const MAX_TITLE = 500;
const MAX_NOTES = 20000;
const SHORT_LABELS = { finished: 'Finished', reading: 'Reading', want: 'Want to read' };

/** The add/edit screen. Route parameter: `id`, for an existing book. */
export default function BookScreen() {
  const navigation = useNavigation();
  const route = useRoute();
  const insets = useSafeAreaInsets();
  const { books, saveBook, deleteBook } = useBooks();
  const id = route.params?.id;
  const existing = id ? books.find((book) => book.id === id) : null;

  // The form starts from the book, once. Later syncs don't overwrite what's being typed.
  const [form, setForm] = useState(() => (existing
    ? { id: existing.id, title: existing.title, authors: existing.authors, categories: existing.categories, status: existing.status, rating: existing.rating, readDate: existing.readDate, notes: existing.notes }
    : emptyBook()));
  const [error, setError] = useState(null);
  const [saving, setSaving] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const authorsRef = useRef(null);
  const categoriesRef = useRef(null);
  const knownAuthors = useMemo(() => distinctNames(books, 'authors'), [books]);
  const knownCategories = useMemo(() => distinctNames(books, 'categories'), [books]);

  const update = (changes) => setForm((current) => ({ ...current, ...changes }));

  /**
   * Validates and saves, then leaves the screen. Also picks up any name typed but not yet
   * confirmed, so "Neil Gaiman" left in the box isn't silently dropped. The `saving` flag
   * stops a double tap from saving twice.
   */
  const save = async () => {
    if (saving) return;
    if (!form.title.trim()) {
      setError('Enter a title.');
      return;
    }
    setSaving(true);
    try {
      await saveBook({
        ...form,
        authors: authorsRef.current ? authorsRef.current.pending() : form.authors,
        categories: categoriesRef.current ? categoriesRef.current.pending() : form.categories,
      });
      navigation.goBack();
    } catch {
      setError('That couldn\'t be saved on this phone. Please try again.');
      setSaving(false);
    }
  };

  /** Deletes after the person confirms in the dialog, then leaves the screen. */
  const remove = async () => {
    setConfirmDelete(false);
    await deleteBook(existing.id);
    navigation.goBack();
  };

  return (
    <Screen title={existing ? 'Book' : 'Add a book'} back>
      {/* Android draws the app behind the keyboard, so this lifts the form above it. */}
      <KeyboardAvoidingView behavior="padding" style={styles.fill}>
        <ScrollView contentContainerStyle={[styles.form, { paddingBottom: insets.bottom + 24 }]} keyboardShouldPersistTaps="handled">
          <Message text={error} />
          <Field
            label="Title"
            value={form.title}
            onChangeText={(title) => { update({ title }); setError(null); }}
            placeholder="Book title"
            autoFocus={!existing}
            autoCapitalize="sentences"
            maxLength={MAX_TITLE}
            returnKeyType="next"
          />
          <NamePicker ref={authorsRef} label="Authors" placeholder="Add an author" value={form.authors} onChange={(authors) => update({ authors })} suggestions={knownAuthors} />
          <View style={styles.block}>
            <SectionTitle>Status</SectionTitle>
            <Segmented
              options={STATUSES.map((status) => ({ id: status.id, label: SHORT_LABELS[status.id] }))}
              value={form.status}
              onChange={(status) => update({ status, readDate: readDateForStatus(status, form.readDate) })}
            />
          </View>
          <View style={styles.block}>
            <SectionTitle>Rating</SectionTitle>
            <Stars value={form.rating} size={30} onChange={(rating) => update({ rating })} />
          </View>
          {/* A read date only means something once a book is finished. */}
          {form.status === 'finished' ? <DateField label="Read date" value={form.readDate} onChange={(readDate) => update({ readDate })} /> : null}
          <NamePicker ref={categoriesRef} label="Categories" placeholder="Add a category" value={form.categories} onChange={(categories) => update({ categories })} suggestions={knownCategories} />
          <Field
            label="Review and notes"
            value={form.notes}
            onChangeText={(notes) => update({ notes })}
            placeholder="What did you think?"
            multiline
            textAlignVertical="top"
            maxLength={MAX_NOTES}
            style={styles.notes}
          />
          <Button label={existing ? 'Save changes' : 'Save book'} onPress={save} busy={saving} />
          {existing ? <Button label="Delete book" kind="danger" onPress={() => setConfirmDelete(true)} style={styles.delete} /> : null}
        </ScrollView>
      </KeyboardAvoidingView>
      <Dialog
        visible={confirmDelete}
        title="Delete this book?"
        message={`"${existing?.title}" and your notes will be removed from all your devices. Only an earlier export can bring them back.`}
        confirmLabel="Delete"
        danger
        onConfirm={remove}
        onCancel={() => setConfirmDelete(false)}
      />
    </Screen>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  form: { padding: 16 },
  block: { marginBottom: 12 },
  notes: { minHeight: 130 },
  delete: { marginTop: 10 },
});
