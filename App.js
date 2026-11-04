// App.js
// The top of the app: wraps everything in the theme and sign-in state, then shows either
// the sign-in screen or the main screens. BooksProvider loads only after sign-in, since
// it needs to know whose books to load.

import React from 'react';
import { ActivityIndicator, View } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { DarkTheme, DefaultTheme, NavigationContainer } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { AuthProvider, useAuth } from './contexts/AuthContext';
import { BooksProvider } from './contexts/BooksContext';
import { ThemeProvider, useTheme } from './contexts/ThemeContext';
import LibraryScreen from './screens/LibraryScreen';
import BookScreen from './screens/BookScreen';
import SearchScreen from './screens/SearchScreen';
import StatsScreen from './screens/StatsScreen';
import SettingsScreen from './screens/SettingsScreen';
import NextcloudScreen from './screens/NextcloudScreen';
import FamilyScreen from './screens/FamilyScreen';
import ServerScreen from './screens/ServerScreen';
import LogsScreen from './screens/LogsScreen';
import HelpScreen from './screens/HelpScreen';
import SignInScreen from './screens/SignInScreen';

const Stack = createNativeStackNavigator();

/**
 * The signed-in screens. Each draws its own top bar (components/Screen.js), so the built-in
 * header is off. `getId` gives each book its own screen, so tapping + while viewing a book
 * opens a blank form rather than reusing the open one, and tapping + on the blank form
 * doesn't stack another.
 */
function MainScreens() {
  return (
    <BooksProvider>
      <Stack.Navigator screenOptions={{ headerShown: false, animation: 'fade_from_bottom' }}>
        <Stack.Screen name="Library" component={LibraryScreen} />
        <Stack.Screen name="Book" component={BookScreen} getId={({ params }) => params?.id ?? 'new'} />
        <Stack.Screen name="Search" component={SearchScreen} />
        <Stack.Screen name="Stats" component={StatsScreen} />
        <Stack.Screen name="Settings" component={SettingsScreen} />
        <Stack.Screen name="Nextcloud" component={NextcloudScreen} />
        <Stack.Screen name="Family" component={FamilyScreen} />
        <Stack.Screen name="Server" component={ServerScreen} />
        <Stack.Screen name="Logs" component={LogsScreen} />
        <Stack.Screen name="Help" component={HelpScreen} />
      </Stack.Navigator>
    </BooksProvider>
  );
}

/** Chooses between loading, sign-in and the app, depending on the sign-in state. */
function Root() {
  const { user, loading } = useAuth();
  const { colors, dark } = useTheme();

  if (loading) {
    return (
      <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.bg }}>
        <ActivityIndicator color={colors.accent} size="large" />
      </View>
    );
  }
  // The navigator's own background colour shows briefly during transitions, so it follows
  // the theme to avoid a flash.
  const base = dark ? DarkTheme : DefaultTheme;
  const navTheme = { ...base, colors: { ...base.colors, background: colors.bg, card: colors.bg } };
  return (
    <NavigationContainer theme={navTheme}>
      {/* `key` makes a different account start fresh, with nothing left from the last one. */}
      {user ? <MainScreens key={user.id} /> : <SignInScreen />}
    </NavigationContainer>
  );
}

/** The app. */
export default function App() {
  return (
    <SafeAreaProvider>
      <ThemeProvider>
        <AuthProvider>
          <Root />
        </AuthProvider>
      </ThemeProvider>
    </SafeAreaProvider>
  );
}
