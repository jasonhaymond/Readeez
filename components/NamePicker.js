// components/NamePicker.js
// Picks several authors or categories: chosen names show as removable chips, typing
// suggests names already in the library or adds a new one, and a "choose from saved" list shows every saved name for
// picking without typing. For authors it can also offer names from an online catalogue. A forwarded ref lets the book
// form collect text the person typed but didn't confirm before tapping Save.

import React, { forwardRef, useImperativeHandle, useMemo, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import { Chip } from './ui';
import { useTheme } from '../contexts/ThemeContext';
import { cleanNames } from '../lib/bookLogic';
import { useBookSuggestions } from '../lib/bookSuggestions';

const MAX_SUGGESTIONS = 5;

/** One suggestion under the box. In: the name and the tap action. */
function SuggestionRow({ name, onPress }) {
  const { colors } = useTheme();
  return (
    <Pressable onPress={onPress} style={[styles.suggestion, { borderColor: colors.border, backgroundColor: colors.surface }]} accessibilityRole="button">
      <Ionicons name="add" size={18} color={colors.muted} />
      <Text style={{ color: colors.text, fontSize: 15, flex: 1 }} numberOfLines={1}>{name}</Text>
    </Pressable>
  );
}

/**
 * Draws the picker.
 * In: label, placeholder, value (array of names), onChange(names), suggestions (saved names), savedLabel (what to call
 * those in the "choose" link, e.g. "authors"), onlineKind ('author' to also ask the online catalogue, or nothing), and
 * wholeEntries (true for book titles, where a comma is part of the text rather than a separator), and onFocus, called
 * when the text box gains focus.
 * Out through the ref: pending(), the chosen names plus anything still in the text box.
 */
const NamePicker = forwardRef(function NamePicker({ label, placeholder, value, onChange, suggestions, savedLabel, onlineKind, wholeEntries = false, onFocus }, ref) {
  const { colors } = useTheme();
  const [text, setText] = useState('');
  const [browsing, setBrowsing] = useState(false);
  const online = useBookSuggestions(onlineKind || 'author', text, Boolean(onlineKind));

  // Splits typed text into names: a comma separates several at once, unless these are whole titles.
  const entries = (raw) => (wholeEntries ? [raw] : raw.split(','));

  /** Adds typed names to the list and empties the box. */
  const add = (raw) => {
    onChange(cleanNames([...value, ...entries(raw)]));
    setText('');
  };

  /** Adds one chosen name as it is, since a name from a list could itself contain a comma. */
  const addOne = (name) => {
    onChange(cleanNames([...value, name]));
    setText('');
  };

  useImperativeHandle(ref, () => ({ pending: () => cleanNames([...value, ...entries(text)]) }), [value, text, wholeEntries]);

  const chosen = useMemo(() => new Set(value.map((name) => name.toLowerCase())), [value]);
  // Saved names not chosen yet, which is everything the "choose" list can offer.
  const available = useMemo(() => suggestions.filter((name) => !chosen.has(name.toLowerCase())), [suggestions, chosen]);
  const query = text.trim().toLowerCase();
  // Saved names containing what's typed.
  const matches = useMemo(() => (query ? available.filter((name) => name.toLowerCase().includes(query)) : available), [available, query]);
  // Catalogue names, leaving out anything already shown or chosen. Saved names come first, as the person's own spelling.
  const onlineMatches = useMemo(() => {
    if (!onlineKind || !query) return [];
    const shown = new Set(matches.map((name) => name.toLowerCase()));
    return online.results.map((item) => item.name).filter((name) => !chosen.has(name.toLowerCase()) && !shown.has(name.toLowerCase()));
  }, [onlineKind, query, online, matches, chosen]);

  return (
    <View style={styles.wrap}>
      <Text style={[styles.label, { color: colors.muted }]}>{label}</Text>
      {value.length ? (
        <View style={styles.chips}>
          {value.map((name) => (
            <Chip key={name} label={name} icon="close" onPress={() => onChange(value.filter((n) => n !== name))} />
          ))}
        </View>
      ) : null}
      <TextInput
        value={text}
        onChangeText={(next) => (next.endsWith(',') && !wholeEntries ? add(next) : setText(next))}
        onSubmitEditing={() => add(text)}
        onFocus={onFocus}
        submitBehavior="submit"
        placeholder={placeholder}
        placeholderTextColor={colors.muted}
        autoCapitalize="words"
        returnKeyType="done"
        accessibilityLabel={label}
        style={[styles.input, { color: colors.text, borderColor: colors.border, backgroundColor: colors.surface }]}
      />
      {/* The list below covers these same names, so while it's open they'd only repeat. */}
      {!browsing && query ? matches.slice(0, MAX_SUGGESTIONS).map((name) => <SuggestionRow key={name} name={name} onPress={() => addOne(name)} />) : null}
      {onlineMatches.map((name) => <SuggestionRow key={`online-${name}`} name={name} onPress={() => addOne(name)} />)}
      {onlineMatches.length ? <Text style={[styles.credit, { color: colors.muted }]}>Suggestions from {online.source}</Text> : null}

      {suggestions.length ? (
        <Pressable
          onPress={() => setBrowsing(!browsing)}
          style={styles.browse}
          accessibilityRole="button"
          accessibilityState={{ expanded: browsing }}
          aria-expanded={browsing}
        >
          <Ionicons name={browsing ? 'chevron-up' : 'chevron-down'} size={18} color={colors.accent} />
          <Text style={{ color: colors.accent, fontSize: 14 }}>Choose from saved {savedLabel}</Text>
        </Pressable>
      ) : null}
      {browsing ? (
        // Scrolls on its own, so a long list doesn't push the rest of the form away.
        <ScrollView style={[styles.saved, { borderColor: colors.border }]} contentContainerStyle={styles.savedContent} nestedScrollEnabled keyboardShouldPersistTaps="handled">
          {matches.map((name) => <Chip key={name} label={name} icon="add" onPress={() => addOne(name)} />)}
          {!matches.length ? <Text style={{ color: colors.muted, fontSize: 14 }}>{query ? 'No saved names match.' : 'You\'ve chosen them all.'}</Text> : null}
        </ScrollView>
      ) : null}
    </View>
  );
});

export default NamePicker;

const styles = StyleSheet.create({
  wrap: { marginBottom: 14 },
  label: { fontSize: 13, marginBottom: 5, fontWeight: '500' },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginBottom: 7 },
  input: { borderWidth: 1, borderRadius: 10, paddingHorizontal: 13, paddingVertical: 11, fontSize: 16, minHeight: 48 },
  suggestion: { flexDirection: 'row', alignItems: 'center', gap: 8, borderWidth: 1, borderTopWidth: 0, paddingHorizontal: 12, minHeight: 44 },
  credit: { fontSize: 12, marginTop: 4 },
  browse: { flexDirection: 'row', alignItems: 'center', gap: 6, minHeight: 44 },
  saved: { maxHeight: 190, borderWidth: 1, borderRadius: 10 },
  savedContent: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, padding: 8 },
});
