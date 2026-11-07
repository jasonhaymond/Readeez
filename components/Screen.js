// components/Screen.js
// The frame around every signed-in screen: the themed background and the top bar. The
// bar always shows the search and add buttons, on every screen, so both are one tap away
// wherever the person is. The ⋮ menu leads to Stats and Settings.

import React, { useState } from 'react';
import { Image, Modal, Pressable, StyleSheet, Text, View } from 'react-native';
import { useNavigation } from '@react-navigation/native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Ionicons from '@expo/vector-icons/Ionicons';
import Background from './Background';
import { useTheme } from '../contexts/ThemeContext';

/**
 * One tappable icon in the top bar, sized to the 48-point minimum for an easy tap.
 * In: icon name, an accessibility label for screen readers, and the tap action.
 */
function HeaderButton({ icon, label, onPress, color }) {
  return (
    <Pressable onPress={onPress} accessibilityRole="button" accessibilityLabel={label} style={styles.headerButton} hitSlop={4}>
      <Ionicons name={icon} size={24} color={color} />
    </Pressable>
  );
}

/**
 * The screen frame.
 * In: title, `back` (shows a back arrow instead of the app's name style), `logo` (shows the app's logo beside
 * the title, for the home screen), children.
 * Out: the laid-out screen. Tapping + or search goes to those screens from anywhere.
 */
export default function Screen({ title, back = false, logo = false, children }) {
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const { colors } = useTheme();
  const [menuOpen, setMenuOpen] = useState(false);

  /** Closes the menu and opens the chosen screen. */
  const openFromMenu = (route) => {
    setMenuOpen(false);
    navigation.navigate(route);
  };

  return (
    <Background>
      <View style={[styles.header, styles.column, { paddingTop: insets.top + 4 }]}>
        {back ? (
          <HeaderButton icon="arrow-back" label="Back" color={colors.text} onPress={() => navigation.goBack()} />
        ) : null}
        {/* The title beside it already says the app's name, so screen readers skip the picture. */}
        {logo ? <Image source={require('../assets/logo-mark.png')} style={styles.logo} accessible={false} /> : null}
        <Text style={[styles.title, { color: colors.text, marginLeft: back ? 0 : logo ? 8 : 12 }]} numberOfLines={1} accessibilityRole="header">
          {title}
        </Text>
        <HeaderButton icon="search" label="Search all books" color={colors.text} onPress={() => navigation.navigate('Search')} />
        <HeaderButton icon="add-circle" label="Add a book" color={colors.accent} onPress={() => navigation.navigate('Book')} />
        <HeaderButton icon="ellipsis-vertical" label="More" color={colors.text} onPress={() => setMenuOpen(true)} />
      </View>
      <View style={[styles.body, styles.column]}>{children}</View>

      {/* A tap outside the menu closes it: the full-screen Pressable sits behind the card. */}
      <Modal visible={menuOpen} transparent animationType="fade" onRequestClose={() => setMenuOpen(false)}>
        <Pressable style={styles.menuBackdrop} onPress={() => setMenuOpen(false)} accessibilityLabel="Close menu">
          <View style={[styles.menu, { top: insets.top + 52, backgroundColor: colors.surface, borderColor: colors.border }]}>
            <MenuItem icon="library-outline" label="Library" colors={colors} onPress={() => openFromMenu('Library')} />
            <MenuItem icon="stats-chart-outline" label="Stats" colors={colors} onPress={() => openFromMenu('Stats')} />
            <MenuItem icon="settings-outline" label="Settings" colors={colors} onPress={() => openFromMenu('Settings')} />
            <MenuItem icon="help-circle-outline" label="Help" colors={colors} onPress={() => openFromMenu('Help')} />
          </View>
        </Pressable>
      </Modal>
    </Background>
  );
}

/** One row in the ⋮ menu. */
function MenuItem({ icon, label, colors, onPress }) {
  return (
    <Pressable onPress={onPress} style={styles.menuItem} accessibilityRole="menuitem">
      <Ionicons name={icon} size={20} color={colors.muted} />
      <Text style={[styles.menuLabel, { color: colors.text }]}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  header: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 4, paddingBottom: 4 },
  headerButton: { width: 48, height: 48, alignItems: 'center', justifyContent: 'center' },
  logo: { width: 30, height: 30, marginLeft: 12 },
  title: { flex: 1, fontSize: 21, fontWeight: '700' },
  body: { flex: 1 },
  // A phone screen is narrower than this. In a wide browser window, it keeps lines at a readable length.
  column: { width: '100%', maxWidth: 760, alignSelf: 'center' },
  menuBackdrop: { flex: 1 },
  menu: { position: 'absolute', right: 8, minWidth: 180, borderRadius: 12, borderWidth: 1, paddingVertical: 6, elevation: 6 },
  menuItem: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 16, minHeight: 48 },
  menuLabel: { fontSize: 16 },
});
