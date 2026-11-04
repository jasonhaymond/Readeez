// components/Background.js
// Fills the screen with the theme's background: a soft gradient for gradient themes, or
// a flat colour otherwise. Everything else is drawn on top of this.

import React from 'react';
import { StatusBar } from 'expo-status-bar';
import { StyleSheet, View } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { useTheme } from '../contexts/ThemeContext';

/** Draws the background. In: children. Also sets the status bar's icons to stay visible. */
export default function Background({ children }) {
  const { colors, gradient, dark } = useTheme();
  const bar = <StatusBar style={dark ? 'light' : 'dark'} />;
  if (gradient) {
    return (
      <LinearGradient colors={gradient} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={styles.fill}>
        {bar}
        {children}
      </LinearGradient>
    );
  }
  return (
    <View style={[styles.fill, { backgroundColor: colors.bg }]}>
      {bar}
      {children}
    </View>
  );
}

const styles = StyleSheet.create({ fill: { flex: 1 } });
