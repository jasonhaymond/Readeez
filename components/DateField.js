// components/DateField.js
// The read date on the book form: a tappable field that opens Android's date picker,
// and can be cleared. On web, used only for the developer's preview, it's a typed date.

import React, { useState } from 'react';
import { Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import DateTimePicker from '@react-native-community/datetimepicker';
import Ionicons from '@expo/vector-icons/Ionicons';
import { Field } from './ui';
import { useTheme } from '../contexts/ThemeContext';
import { formatDate, localDate } from '../lib/bookLogic';

/**
 * Draws the field. In: label, value ('YYYY-MM-DD'), onChange(text).
 */
export default function DateField({ label, value, onChange }) {
  const { colors } = useTheme();
  const [open, setOpen] = useState(false);

  if (Platform.OS === 'web') {
    return <Field label={label} value={value || ''} onChangeText={onChange} placeholder="YYYY-MM-DD" />;
  }

  // The picker works on a Date. Split into parts, so it's read as a local date and can't
  // land on the day before.
  const [year, month, day] = (value || localDate()).split('-').map(Number);
  return (
    <View style={styles.wrap}>
      <Text style={[styles.label, { color: colors.muted }]}>{label}</Text>
      <Pressable
        onPress={() => setOpen(true)}
        accessibilityRole="button"
        accessibilityLabel={`${label}: ${formatDate(value) || 'not set'}`}
        style={[styles.field, { borderColor: colors.border, backgroundColor: colors.surface }]}
      >
        <Text style={{ color: colors.text, fontSize: 16 }}>{formatDate(value) || 'Not set'}</Text>
        <Ionicons name="calendar-outline" size={20} color={colors.muted} />
      </Pressable>
      {open ? (
        <DateTimePicker
          value={new Date(year, month - 1, day)}
          mode="date"
          onChange={(event, date) => {
            // Android's picker closes itself; only "OK" counts as a change.
            setOpen(false);
            if (event.type === 'set' && date) onChange(localDate(date));
          }}
        />
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { marginBottom: 14 },
  label: { fontSize: 13, marginBottom: 5, fontWeight: '500' },
  field: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', borderWidth: 1, borderRadius: 10, paddingHorizontal: 13, minHeight: 48 },
});
