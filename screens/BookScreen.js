// screens/BookScreen.js
// Adding and editing a book, on one form. It's opened with no id to add (the + button,
// with the title field ready to type) or with a book's id to view and edit it. Everything
// is optional except the title, and the read date defaults to today.

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Keyboard, KeyboardAvoidingView, Platform, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useNavigation, useRoute } from '@react-navigation/native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Ionicons from '@expo/vector-icons/Ionicons';
import Screen from '../components/Screen';
import NamePicker from '../components/NamePicker';
import DateField from '../components/DateField';
import { Button, Dialog, Field, Message, Segmented, SectionTitle, Stars } from '../components/ui';
import { useBooks } from '../contexts/BooksContext';
import { useTheme } from '../contexts/ThemeContext';
import { boxTitlesProblem, cleanNames, distinctNames, emptyBook, parseBox, readDateForStatus, setCategoryRating, STATUSES } from '../lib/bookLogic';
import { useBookSuggestions, useSuggestionSetting } from '../lib/bookSuggestions';
import { useDeviceSetting } from '../lib/deviceSettings';
import { useRevealFocusedField } from '../lib/useRevealFocusedField';

// Matches the limits the server enforces (server/bookValidation.js).
const MAX_TITLE = 500;
const MAX_NOTES = 20000;
const SHORT_LABELS = { finished: 'Finished', reading: 'Reading', want: 'Want to read' };

/** The add/edit screen. Route parameter: `id`, for an existing book. */
export default function BookScreen() {
  const navigation = useNavigation();
  const route = useRoute();
  const insets = useSafeAreaInsets();
  const { colors } = useTheme();
  const { books, saveBook, deleteBook } = useBooks();
  const id = route.params?.id;
  const existing = id ? books.find((book) => book.id === id) : null;

  // The form starts from the book, once. Later syncs don't overwrite what's being typed. The box counts are kept as text
  // while being edited, because a half-typed number isn't a number yet.
  const [form, setForm] = useState(() => (existing
    ? {
      id: existing.id, title: existing.title, authors: existing.authors, categories: existing.categories, status: existing.status,
      rating: existing.rating, categoryRatings: existing.categoryRatings || [], readDate: existing.readDate, notes: existing.notes,
      boxTotal: existing.boxTotal ? String(existing.boxTotal) : '', boxRead: existing.boxTotal ? String(existing.boxRead ?? 0) : '',
      boxTitles: existing.boxTitles || [],
    }
    : { ...emptyBook(), boxTotal: '', boxRead: '' }));
  const [boxOpen, setBoxOpen] = useState(Boolean(existing?.boxTotal));
  const [error, setError] = useState(null);
  const [saving, setSaving] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  // True once a suggested title is chosen, so its suggestions close until the title is typed in again.
  const [titleChosen, setTitleChosen] = useState(false);
  // True while someone is working in the title box. Its suggestions close afterward, so they don't push the rest of the
  // form down while the person fills it in.
  const [titleActive, setTitleActive] = useState(false);
  const { scrollRef, onScroll, reveal } = useRevealFocusedField();
  const [suggestionsOn] = useSuggestionSetting();
  // Off unless chosen in Settings, since most people only want to count a box's books.
  const [boxTitlesOn] = useDeviceSetting('rz:box-titles', false);
  const authorsRef = useRef(null);
  const categoriesRef = useRef(null);
  const boxTitlesRef = useRef(null);
  const knownAuthors = useMemo(() => distinctNames(books, 'authors'), [books]);
  const knownCategories = useMemo(() => distinctNames(books, 'categories'), [books]);
  // Only while adding: a book already saved has its title, and shouldn't send it anywhere just for being opened.
  const titleSuggestions = useBookSuggestions('title', form.title, suggestionsOn && !existing && !titleChosen);

  // On Android, pressing back to close the keyboard leaves the box focused, so that counts as moving on as well.
  useEffect(() => {
    const hidden = Keyboard.addListener('keyboardDidHide', () => setTitleActive(false));
    return () => hidden.remove();
  }, []);

  const update = (changes) => setForm((current) => ({ ...current, ...changes }));
  const boxReadNumber = Number(form.boxRead) || 0;

  /** Fills in the form from a suggested title, adding its authors to any already there. */
  const chooseTitle = (suggestion) => {
    update({ title: suggestion.title, authors: cleanNames([...form.authors, ...suggestion.authors]) });
    setTitleChosen(true);
    setError(null);
  };

  /** Changes the status. Marking a box finished assumes all its books are read, which the field below can still correct. */
  const changeStatus = (status) => {
    const total = Number(form.boxTotal) || 0;
    const boxRead = status === 'finished' && total ? String(total) : form.boxRead;
    update({ status, boxRead, readDate: readDateForStatus(status, form.readDate, Number(boxRead) || 0) });
  };

  /** Changes the number read from a box. Reading the last one finishes it, and a first one read gets a date. */
  const changeBoxRead = (boxRead) => {
    const count = Number(boxRead) || 0;
    const total = Number(form.boxTotal) || 0;
    const status = total && count >= total ? 'finished' : form.status;
    update({ boxRead, status, readDate: readDateForStatus(status, form.readDate, count) });
  };

  /**
   * Validates and saves, then leaves the screen. Also picks up any name typed but not yet
   * confirmed, so "Neil Gaiman" left in the box isn't silently dropped. The `saving` flag
   * stops a double tap from saving twice. A browser can fail here if the server can't be reached.
   */
  const save = async () => {
    if (saving) return;
    if (!form.title.trim()) {
      setError('Enter a title.');
      return;
    }
    const box = parseBox(form.boxTotal, form.boxRead, form.status);
    if (box.error) {
      setBoxOpen(true);
      setError(box.error);
      return;
    }
    const boxTitles = boxTitlesRef.current ? boxTitlesRef.current.pending() : form.boxTitles;
    const titlesProblem = boxTitlesProblem(boxTitles, box.boxTotal);
    if (titlesProblem) {
      setBoxOpen(true);
      setError(titlesProblem);
      return;
    }
    setSaving(true);
    try {
      await saveBook({
        ...form,
        ...box,
        boxTitles,
        authors: authorsRef.current ? authorsRef.current.pending() : form.authors,
        categories: categoriesRef.current ? categoriesRef.current.pending() : form.categories,
      });
      navigation.goBack();
    } catch (err) {
      setError(Platform.OS === 'web' ? err.message : 'That couldn\'t be saved on this phone. Please try again.');
      setSaving(false);
    }
  };

  /** Deletes after the person confirms in the dialog, then leaves the screen. A browser can fail, as with saving. */
  const remove = async () => {
    setConfirmDelete(false);
    try {
      await deleteBook(existing.id);
      navigation.goBack();
    } catch (err) {
      setError(err.message);
    }
  };

  const ratingFor = (category) => form.categoryRatings.find((item) => item.category.toLowerCase() === category.toLowerCase())?.rating ?? null;

  return (
    <Screen title={existing ? 'Book' : 'Add a book'} back>
      {/* Android draws the app behind the keyboard, so this lifts the form above it. */}
      <KeyboardAvoidingView behavior="padding" style={styles.fill}>
        <ScrollView ref={scrollRef} onScroll={onScroll} scrollEventThrottle={32} contentContainerStyle={[styles.form, { paddingBottom: insets.bottom + 24 }]} keyboardShouldPersistTaps="handled">
          <Field
            label="Title"
            value={form.title}
            onChangeText={(title) => { update({ title }); setError(null); setTitleChosen(false); setTitleActive(true); }}
            onFocus={() => { setTitleActive(true); reveal(); }}
            onPressIn={() => setTitleActive(true)}
            // Waits a moment, because in a browser clicking a suggestion blurs the box first, and the click must still land.
            onBlur={() => setTimeout(() => setTitleActive(false), 250)}
            placeholder="Book title"
            autoFocus={!existing}
            autoCapitalize="sentences"
            maxLength={MAX_TITLE}
            returnKeyType="next"
          />
          {titleActive && titleSuggestions.results.length ? (
            <View style={styles.titleSuggestions}>
              {titleSuggestions.results.map((item) => (
                <Pressable
                  key={`${item.title}|${item.authors.join()}`}
                  onPress={() => chooseTitle(item)}
                  accessibilityRole="button"
                  style={[styles.titleSuggestion, { borderColor: colors.border, backgroundColor: colors.surface }]}
                >
                  <Text style={{ color: colors.text, fontSize: 15 }} numberOfLines={1}>{item.title}</Text>
                  {item.authors.length ? <Text style={{ color: colors.muted, fontSize: 13 }} numberOfLines={1}>{item.authors.join(', ')}</Text> : null}
                </Pressable>
              ))}
              <Text style={[styles.credit, { color: colors.muted }]}>Suggestions from {titleSuggestions.source}</Text>
            </View>
          ) : null}
          <NamePicker ref={authorsRef} label="Authors" placeholder="Add an author" value={form.authors} onChange={(authors) => update({ authors })} suggestions={knownAuthors} savedLabel="authors" onlineKind={suggestionsOn ? 'author' : undefined} onFocus={reveal} />
          <View style={styles.block}>
            <SectionTitle>Status</SectionTitle>
            <Segmented
              options={STATUSES.map((status) => ({ id: status.id, label: SHORT_LABELS[status.id] }))}
              value={form.status}
              onChange={changeStatus}
            />
          </View>

          {/* Closed unless it's in use, since most books aren't boxes. */}
          <Pressable onPress={() => setBoxOpen(!boxOpen)} style={styles.expander} accessibilityRole="button" accessibilityState={{ expanded: boxOpen }} aria-expanded={boxOpen}>
            <Ionicons name={boxOpen ? 'chevron-up' : 'chevron-down'} size={18} color={colors.accent} />
            <Text style={{ color: colors.accent, fontSize: 15 }}>This is a book box</Text>
          </Pressable>
          {boxOpen ? (
            <View style={styles.boxFields}>
              <View style={styles.half}>
                <Field onFocus={reveal} label="Books in the box" value={form.boxTotal} onChangeText={(boxTotal) => { update({ boxTotal }); setError(null); }} keyboardType="number-pad" maxLength={4} placeholder="e.g. 7" />
              </View>
              <View style={styles.half}>
                <Field onFocus={reveal} label="Books read" value={form.boxRead} onChangeText={(boxRead) => { changeBoxRead(boxRead); setError(null); }} keyboardType="number-pad" maxLength={4} placeholder="0" />
              </View>
            </View>
          ) : null}
          {/* Titles already entered stay visible with the setting off, so turning it off can't seem to lose them. */}
          {boxOpen && (boxTitlesOn || form.boxTitles.length) ? (
            <NamePicker ref={boxTitlesRef} label="Titles in this box (optional)" placeholder="Add a title" value={form.boxTitles} onChange={(boxTitles) => update({ boxTitles })} suggestions={[]} wholeEntries onFocus={reveal} />
          ) : null}

          <View style={styles.block}>
            <SectionTitle>Rating</SectionTitle>
            <Stars value={form.rating} size={30} onChange={(rating) => update({ rating })} />
          </View>
          {/* A read date only means something once a book is finished, or some of a box has been read. */}
          {form.status === 'finished' || boxReadNumber > 0 ? <DateField label="Read date" value={form.readDate} onChange={(readDate) => update({ readDate })} /> : null}
          <NamePicker ref={categoriesRef} label="Categories" placeholder="Add a category" value={form.categories} onChange={(categories) => update({ categories })} suggestions={knownCategories} savedLabel="categories" onFocus={reveal} />
          {form.categories.length ? (
            <View style={styles.block}>
              <SectionTitle>Category ratings</SectionTitle>
              {form.categories.map((category) => (
                <View key={category} style={styles.categoryRating}>
                  <Text style={[styles.categoryName, { color: colors.text }]} numberOfLines={1}>{category}</Text>
                  <Stars
                    value={ratingFor(category)}
                    size={24}
                    label={category}
                    onChange={(rating) => update({ categoryRatings: setCategoryRating(form.categoryRatings, category, rating) })}
                  />
                </View>
              ))}
            </View>
          ) : null}
          <Field
            label="Review and notes"
            onFocus={reveal}
            value={form.notes}
            onChangeText={(notes) => update({ notes })}
            placeholder="What did you think?"
            multiline
            textAlignVertical="top"
            maxLength={MAX_NOTES}
            style={styles.notes}
          />
          {/* Next to the button just tapped, because the top of a long form has scrolled out of sight by then. */}
          <Message text={error} />
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
  titleSuggestions: { marginTop: -8, marginBottom: 14 },
  titleSuggestion: { borderWidth: 1, borderTopWidth: 0, paddingHorizontal: 12, paddingVertical: 8, minHeight: 44, justifyContent: 'center' },
  credit: { fontSize: 12, marginTop: 4 },
  expander: { flexDirection: 'row', alignItems: 'center', gap: 6, minHeight: 44, marginBottom: 6 },
  boxFields: { flexDirection: 'row', gap: 10 },
  half: { flex: 1 },
  categoryRating: { marginBottom: 4 },
  categoryName: { fontSize: 15 },
});
