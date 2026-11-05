// components/NamePicker.js
// Picks several authors or categories: chosen names show as removable chips, and typing
// suggests names already in the library, or adds a new one. A forwarded ref lets the book
// form collect text the person typed but didn't confirm before tapping Save.

import React, { forwardRef, useImperativeHandle, useMemo, useState } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import { Chip } from './ui';
import { useTheme } from '../contexts/ThemeContext';
import { cleanNames } from '../lib/bookLogic';

const MAX_SUGGESTIONS = 5;

/**
 * Draws the picker.
 * In: label, placeholder, value (array of names), onChange(names), suggestions (known names).
 * Out through the ref: pending(), the chosen names plus anything still in the text box.
 */
const NamePicker = forwardRef(function NamePicker({ label, placeholder, value, onChange, suggestions }, ref) {
  const { colors } = useTheme();
  const [text, setText] = useState('');

  /** Adds names to the list and empties the box. A comma separates several at once. */
  const add = (raw) => {
    onChange(cleanNames([...value, ...raw.split(',')]));
    setText('');
  };

  useImperativeHandle(ref, () => ({ pending: () => cleanNames([...value, ...text.split(',')]) }), [value, text]);

  // Known names containing what's typed, leaving out those already chosen.
  const matches = useMemo(() => {
    const query = text.trim().toLowerCase();
    if (!query) return [];
    const chosen = new Set(value.map((name) => name.toLowerCase()));
    return suggestions.filter((name) => name.toLowerCase().includes(query) && !chosen.has(name.toLowerCase())).slice(0, MAX_SUGGESTIONS);
  }, [text, value, suggestions]);

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
        onChangeText={(next) => (next.endsWith(',') ? add(next) : setText(next))}
        onSubmitEditing={() => add(text)}
        submitBehavior="submit"
        placeholder={placeholder}
        placeholderTextColor={colors.muted}
        autoCapitalize="words"
        returnKeyType="done"
        accessibilityLabel={label}
        style={[styles.input, { color: colors.text, borderColor: colors.border, backgroundColor: colors.surface }]}
      />
      {matches.map((name) => (
        <Pressable key={name} onPress={() => add(name)} style={[styles.suggestion, { borderColor: colors.border, backgroundColor: colors.surface }]} accessibilityRole="button">
          <Ionicons name="add" size={18} color={colors.muted} />
          <Text style={{ color: colors.text, fontSize: 15, flex: 1 }} numberOfLines={1}>{name}</Text>
        </Pressable>
      ))}
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
});
