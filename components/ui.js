// components/ui.js
// The small building blocks the screens share, so everything looks and behaves the same:
// buttons, text fields, cards, pill-shaped choices, stars, and a confirmation dialog.
//
// Controls state what they are twice: accessibilityState is what Android's screen reader reads, and the aria- properties
// are what a browser's reads, because the browser version ignores accessibilityState.

import React from 'react';
import { ActivityIndicator, Modal, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import { useTheme } from '../contexts/ThemeContext';

/**
 * A button.
 * In: label, onPress, kind ('primary', 'secondary' or 'danger'), busy (shows a spinner and
 * ignores taps, which also stops a double-tap saving twice), disabled.
 */
export function Button({ label, onPress, kind = 'primary', busy = false, disabled = false, style }) {
  const { colors } = useTheme();
  const primary = kind === 'primary';
  const foreground = primary ? colors.onAccent : kind === 'danger' ? '#C62828' : colors.text;
  return (
    <Pressable
      onPress={onPress}
      disabled={busy || disabled}
      accessibilityRole="button"
      accessibilityState={{ disabled: busy || disabled, busy }}
      aria-busy={busy}
      style={({ pressed }) => [
        styles.button,
        primary ? { backgroundColor: colors.accent } : { borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surface },
        { opacity: disabled ? 0.5 : pressed ? 0.8 : 1 },
        style,
      ]}
    >
      {busy ? <ActivityIndicator color={foreground} /> : <Text style={[styles.buttonLabel, { color: foreground }]}>{label}</Text>}
    </Pressable>
  );
}

/**
 * A labelled text field. In: label, optional hint, and anything TextInput accepts.
 */
export function Field({ label, hint, style, ...inputProps }) {
  const { colors, dark } = useTheme();
  return (
    <View style={styles.field}>
      {label ? <Text style={[styles.fieldLabel, { color: colors.muted }]}>{label}</Text> : null}
      <TextInput
        placeholderTextColor={colors.muted}
        keyboardAppearance={dark ? 'dark' : 'light'}
        style={[styles.input, { color: colors.text, borderColor: colors.border, backgroundColor: colors.surface }, style]}
        accessibilityLabel={label}
        {...inputProps}
      />
      {hint ? <Text style={[styles.hint, { color: colors.muted }]}>{hint}</Text> : null}
    </View>
  );
}

/** A rounded panel for grouping content. In: children and optional extra style. */
export function Card({ children, style }) {
  const { colors } = useTheme();
  return <View style={[styles.card, { backgroundColor: colors.surface, borderColor: colors.border }, style]}>{children}</View>;
}

/** A small section heading. */
export function SectionTitle({ children }) {
  const { colors } = useTheme();
  return <Text style={[styles.sectionTitle, { color: colors.muted }]} accessibilityRole="header">{children}</Text>;
}

/** An error or status message; renders nothing when there's no message. */
export function Message({ text, kind = 'error' }) {
  const { colors } = useTheme();
  if (!text) return null;
  return <Text style={[styles.message, { color: kind === 'error' ? '#C62828' : colors.muted }]} accessibilityLiveRegion="polite">{text}</Text>;
}

/**
 * A row of choices where one is selected, such as status or light/dark.
 * In: options [{ id, label }], the selected id, and onChange(id).
 */
export function Segmented({ options, value, onChange }) {
  const { colors } = useTheme();
  return (
    <View style={[styles.segmented, { borderColor: colors.border, backgroundColor: colors.surface }]} accessibilityRole="radiogroup">
      {options.map((option) => {
        const selected = option.id === value;
        return (
          <Pressable
            key={option.id}
            onPress={() => onChange(option.id)}
            accessibilityRole="radio"
            accessibilityState={{ selected, checked: selected }}
            aria-checked={selected}
            style={[styles.segment, selected && { backgroundColor: colors.accent }]}
          >
            <Text style={{ color: selected ? colors.onAccent : colors.text, fontWeight: selected ? '600' : '400', fontSize: 14 }} numberOfLines={1}>
              {option.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

/** A pill-shaped toggle or filter. In: label, selected, onPress, and optional icon. */
export function Chip({ label, selected, onPress, icon }) {
  const { colors } = useTheme();
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityState={{ selected: Boolean(selected) }}
      aria-pressed={Boolean(selected)}
      style={[styles.chip, { borderColor: selected ? colors.accent : colors.border, backgroundColor: selected ? colors.accent : colors.surface }]}
    >
      <Text style={{ color: selected ? colors.onAccent : colors.text, fontSize: 14 }} numberOfLines={1}>{label}</Text>
      {icon ? <Ionicons name={icon} size={15} color={selected ? colors.onAccent : colors.muted} /> : null}
    </Pressable>
  );
}

/**
 * 1 to 5 stars. Read-only unless onChange is given. Tapping the current rating clears it,
 * because a rating is optional.
 * In: value (1 to 5 or null), size, optional onChange(valueOrNull), and optional label, which tells a screen reader what
 * these stars rate when a screen has several rows of them.
 */
export function Stars({ value, size = 16, onChange, label }) {
  const { colors } = useTheme();
  const star = (n) => (
    <Ionicons name={value >= n ? 'star' : 'star-outline'} size={size} color={value >= n ? colors.accent : colors.muted} />
  );
  if (!onChange) {
    return (
      <View style={styles.stars} accessible accessibilityLabel={value ? `${value} out of 5 stars` : 'Not rated'}>
        {[1, 2, 3, 4, 5].map((n) => <View key={n}>{star(n)}</View>)}
      </View>
    );
  }
  return (
    <View style={styles.stars}>
      {[1, 2, 3, 4, 5].map((n) => (
        <Pressable
          key={n}
          onPress={() => onChange(value === n ? null : n)}
          style={styles.starButton}
          accessibilityRole="button"
          accessibilityLabel={`${label ? `${label}: ` : ''}${n} star${n > 1 ? 's' : ''}`}
          accessibilityState={{ selected: value === n }}
          aria-pressed={value === n}
        >
          {star(n)}
        </Pressable>
      ))}
    </View>
  );
}

/**
 * A dialog over the current screen.
 * In: visible, title, message or children, confirmLabel, onConfirm, onCancel (leave it out
 * for a dialog with one button), danger (a red confirm button).
 */
export function Dialog({ visible, title, message, children, confirmLabel = 'OK', onConfirm, onCancel, danger, busy }) {
  const { colors } = useTheme();
  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onCancel || onConfirm}>
      <View style={styles.dialogBackdrop}>
        <View style={[styles.dialog, { backgroundColor: colors.surface, borderColor: colors.border }]} accessibilityViewIsModal>
          <Text style={[styles.dialogTitle, { color: colors.text }]} accessibilityRole="header">{title}</Text>
          {message ? <Text style={[styles.dialogMessage, { color: colors.text }]}>{message}</Text> : null}
          {children}
          <View style={styles.dialogButtons}>
            {onCancel ? <Button label="Cancel" kind="secondary" onPress={onCancel} style={styles.dialogButton} /> : null}
            <Button label={confirmLabel} kind={danger ? 'danger' : 'primary'} onPress={onConfirm} busy={busy} style={styles.dialogButton} />
          </View>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  button: { minHeight: 48, borderRadius: 10, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 18 },
  buttonLabel: { fontSize: 16, fontWeight: '600' },
  field: { marginBottom: 14 },
  fieldLabel: { fontSize: 13, marginBottom: 5, fontWeight: '500' },
  input: { borderWidth: 1, borderRadius: 10, paddingHorizontal: 13, paddingVertical: 11, fontSize: 16, minHeight: 48 },
  hint: { fontSize: 12, marginTop: 4 },
  card: { borderWidth: 1, borderRadius: 12, padding: 14, marginBottom: 12 },
  sectionTitle: { fontSize: 13, fontWeight: '600', marginTop: 10, marginBottom: 7, textTransform: 'uppercase', letterSpacing: 0.5 },
  message: { fontSize: 14, marginBottom: 12 },
  segmented: { flexDirection: 'row', borderWidth: 1, borderRadius: 10, padding: 3, gap: 3 },
  segment: { flex: 1, minHeight: 42, alignItems: 'center', justifyContent: 'center', borderRadius: 7, paddingHorizontal: 4 },
  chip: { flexDirection: 'row', alignItems: 'center', gap: 4, minHeight: 36, borderWidth: 1, borderRadius: 18, paddingHorizontal: 13, maxWidth: 240 },
  stars: { flexDirection: 'row', alignItems: 'center' },
  starButton: { width: 48, height: 48, alignItems: 'center', justifyContent: 'center' },
  dialogBackdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', alignItems: 'center', justifyContent: 'center', padding: 24 },
  dialog: { width: '100%', maxWidth: 420, borderRadius: 14, borderWidth: 1, padding: 20 },
  dialogTitle: { fontSize: 18, fontWeight: '700', marginBottom: 8 },
  dialogMessage: { fontSize: 15, lineHeight: 21, marginBottom: 12 },
  dialogButtons: { flexDirection: 'row', gap: 10, marginTop: 8 },
  dialogButton: { flex: 1 },
});
