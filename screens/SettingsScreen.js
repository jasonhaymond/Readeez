// screens/SettingsScreen.js
// Settings: appearance (mode and theme), sync status, book suggestions, book boxes, exports, account, and, for admins,
// links to the family and server panels. Appearance, suggestions and book boxes apply only to this device.

import React, { useState } from 'react';
import { Platform, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useNavigation } from '@react-navigation/native';
import { LinearGradient } from 'expo-linear-gradient';
import Ionicons from '@expo/vector-icons/Ionicons';
import Screen from '../components/Screen';
import { Button, Card, Dialog, Field, Message, Segmented, SectionTitle } from '../components/ui';
import { useAuth } from '../contexts/AuthContext';
import { useBooks } from '../contexts/BooksContext';
import { useTheme } from '../contexts/ThemeContext';
import { MODES, THEMES } from '../constants/themes';
import * as api from '../lib/api';
import { pickExportFile, shareExport } from '../lib/exportFile';
import { parseExport, planImport } from '../lib/importBooks';
import { useSuggestionSetting } from '../lib/bookSuggestions';
import { useDeviceSetting } from '../lib/deviceSettings';
import appConfig from '../app.json';

const IS_WEB = Platform.OS === 'web';

/**
 * A tappable colour sample for choosing a theme, drawn in the mode now in use.
 * In: theme, selected, onPress.
 */
function ThemeSwatch({ theme, selected, onPress }) {
  const { dark, colors } = useTheme();
  const palette = dark ? theme.dark : theme.light;
  const gradient = dark ? theme.darkGradient : theme.lightGradient;
  const inner = (
    <View style={[styles.swatchDot, { backgroundColor: palette.accent }]}>
      {selected ? <Ionicons name="checkmark" size={16} color={palette.onAccent} /> : null}
    </View>
  );
  return (
    <Pressable onPress={onPress} accessibilityRole="radio" accessibilityState={{ selected, checked: selected }} aria-checked={selected} accessibilityLabel={`${theme.name} theme`} style={styles.swatch}>
      {gradient ? (
        <LinearGradient colors={gradient} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={[styles.swatchBox, { borderColor: selected ? colors.accent : colors.border }]}>{inner}</LinearGradient>
      ) : (
        <View style={[styles.swatchBox, { backgroundColor: palette.bg, borderColor: selected ? colors.accent : colors.border }]}>{inner}</View>
      )}
      <Text style={[styles.swatchName, { color: colors.text }]} numberOfLines={1}>{theme.name}</Text>
    </Pressable>
  );
}

/** A row that opens another screen. In: icon, label, onPress. */
function LinkRow({ icon, label, onPress }) {
  const { colors } = useTheme();
  return (
    <Pressable onPress={onPress} accessibilityRole="button" style={styles.linkRow}>
      <Ionicons name={icon} size={20} color={colors.muted} />
      <Text style={[styles.linkLabel, { color: colors.text }]}>{label}</Text>
      <Ionicons name="chevron-forward" size={18} color={colors.muted} />
    </Pressable>
  );
}

/**
 * Describes the sync state in words.
 * In: the sync state and the count of unsent changes. Out: a sentence.
 */
function syncSentence(sync, pendingCount) {
  if (sync.state === 'syncing') return 'Syncing…';
  const waiting = pendingCount ? ` ${pendingCount} waiting to send.` : '';
  if (sync.state === 'offline') return IS_WEB ? 'Can\'t reach the server. Changes can\'t be saved until it\'s back.' : `Offline. Your books are safe on this phone.${waiting}`;
  if (sync.state === 'error') return `${sync.message}${waiting}`;
  return sync.lastAt ? `Up to date as of ${new Date(sync.lastAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}.${waiting}` : `Not synced yet.${waiting}`;
}

/** The settings screen. */
export default function SettingsScreen() {
  const navigation = useNavigation();
  const { colors, mode, setMode, themeId, setThemeId } = useTheme();
  const { user, signOut } = useAuth();
  const { books, allBooks, importBooks, ready, sync, syncNow, pendingCount } = useBooks();
  const [suggestionsOn, setSuggestionsOn] = useSuggestionSetting();
  const [boxTitlesOn, setBoxTitlesOn] = useDeviceSetting('rz:box-titles', false);
  // What an import would do, waiting for confirmation: { plan, invalid }.
  const [importing, setImporting] = useState(null);
  const [importDone, setImportDone] = useState(null);
  const [exportError, setExportError] = useState(null);
  const [confirmSignOut, setConfirmSignOut] = useState(false);
  const [signingOut, setSigningOut] = useState(false);
  const [signOutError, setSignOutError] = useState(null);
  const [passwordOpen, setPasswordOpen] = useState(false);

  // Until the books have loaded, the list is empty. An export would be an empty file that looks like a good copy, and
  // an import would treat every book in the file as new and overwrite newer edits.
  const notLoaded = 'Your books haven\'t loaded, so that can\'t be done yet.';

  /** Opens the share menu, or in a browser starts a download, with the library in the chosen format. */
  const runExport = async (format) => {
    setExportError(null);
    if (!ready) {
      setExportError(notLoaded);
      return;
    }
    try {
      await shareExport(books, format);
    } catch (err) {
      setExportError(err.message);
    }
  };

  /**
   * Picks an export file and works out what it would change. Nothing changes until the person
   * confirms, since they may have picked the wrong file.
   */
  const startImport = async () => {
    setExportError(null);
    setImportDone(null);
    if (!ready) {
      setExportError(notLoaded);
      return;
    }
    try {
      const text = await pickExportFile();
      if (text === null) return;
      const { books: fileBooks, invalid } = parseExport(text);
      setImporting({ plan: planImport(allBooks, fileBooks), invalid });
    } catch (err) {
      setExportError(err.message);
    }
  };

  /** Applies the confirmed import. */
  const finishImport = async () => {
    const { plan } = importing;
    setImporting(null);
    try {
      await importBooks(plan.toSave);
      setImportDone(`Imported: ${plan.added} added, ${plan.updated} updated.`);
    } catch (err) {
      // Only a browser gets here: it can't import without the server. Anything that arrived stays, so trying again sends the rest.
      setExportError(err.message);
    }
  };

  /** Signs out after the confirmation dialog. In a browser this can fail, and then the person stays signed in and is told. */
  const doSignOut = async () => {
    setSigningOut(true);
    setSignOutError(null);
    try {
      await signOut();
    } catch (err) {
      setSignOutError(`You're still signed in. ${err.message}`);
      setSigningOut(false);
      setConfirmSignOut(false);
    }
  };

  return (
    <Screen title="Settings" back>
      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        <SectionTitle>Appearance</SectionTitle>
        <Card>
          <Segmented options={MODES} value={mode} onChange={setMode} />
          <View style={styles.swatches} accessibilityRole="radiogroup">
            {THEMES.map((theme) => <ThemeSwatch key={theme.id} theme={theme} selected={theme.id === themeId} onPress={() => setThemeId(theme.id)} />)}
          </View>
        </Card>

        <SectionTitle>Sync</SectionTitle>
        <Card>
          <Text style={[styles.body, { color: colors.text }]}>{syncSentence(sync, pendingCount)}</Text>
          <Button label="Sync now" kind="secondary" onPress={syncNow} busy={sync.state === 'syncing'} />
        </Card>

        <SectionTitle>Book suggestions</SectionTitle>
        <Card>
          <Text style={[styles.body, { color: colors.text }]}>
            When you add a book, Readeez can suggest titles and authors from Open Library, and from Google Books if your family's admin has added it. What you type in those boxes goes to your Readeez server, then to that online catalogue. Your library and notes are never sent.
          </Text>
          <Segmented options={[{ id: 'on', label: 'On' }, { id: 'off', label: 'Off' }]} value={suggestionsOn ? 'on' : 'off'} onChange={(choice) => setSuggestionsOn(choice === 'on')} />
        </Card>

        <SectionTitle>Book boxes</SectionTitle>
        <Card>
          <Text style={[styles.body, { color: colors.text }]}>
            A book box is one title with a count of its books. Choose Enter titles if you also want to list the books inside. This setting is for this {IS_WEB ? 'browser' : 'phone'} only.
          </Text>
          <Segmented options={[{ id: 'count', label: 'Just count' }, { id: 'titles', label: 'Enter titles' }]} value={boxTitlesOn ? 'titles' : 'count'} onChange={(choice) => setBoxTitlesOn(choice === 'titles')} />
        </Card>

        <SectionTitle>Backups and exports</SectionTitle>
        <Card>
          <Message text={exportError} />
          <View style={styles.twoButtons}>
            <Button label={IS_WEB ? 'Download CSV' : 'Share CSV'} kind="secondary" onPress={() => runExport('csv')} style={styles.half} />
            <Button label={IS_WEB ? 'Download JSON' : 'Share JSON'} kind="secondary" onPress={() => runExport('json')} style={styles.half} />
          </View>
          <Button label="Import a JSON export" kind="secondary" onPress={startImport} style={styles.gap} />
          <Message text={importDone} kind="info" />
          <LinkRow icon="cloud-outline" label="Nextcloud" onPress={() => navigation.navigate('Nextcloud')} />
        </Card>

        {user?.role === 'admin' ? (
          <>
            <SectionTitle>Admin</SectionTitle>
            <Card>
              <LinkRow icon="people-outline" label="Family accounts" onPress={() => navigation.navigate('Family')} />
              <LinkRow icon="server-outline" label="Server" onPress={() => navigation.navigate('Server')} />
            </Card>
          </>
        ) : null}

        <SectionTitle>Account</SectionTitle>
        <Card>
          <Text style={[styles.name, { color: colors.text }]}>{user?.displayName}</Text>
          <Text style={[styles.body, { color: colors.muted }]}>{user?.email}</Text>
          {user?.adminResets?.length ? (
            <Text style={[styles.body, { color: colors.muted }]}>Reset codes used on this account: {user.adminResets.map((at) => new Date(at).toLocaleString()).join(', ')}{user.adminResetsEarlier ? `, and ${user.adminResetsEarlier} earlier` : ''}</Text>
          ) : null}
          <Button label="Change password" kind="secondary" onPress={() => setPasswordOpen(true)} style={styles.gap} />
          <Message text={signOutError} />
          <Button label="Sign out" kind="secondary" onPress={() => setConfirmSignOut(true)} />
        </Card>

        <Text style={[styles.version, { color: colors.muted }]}>Readeez {appConfig.expo.version}</Text>
      </ScrollView>

      <Dialog
        visible={confirmSignOut}
        title="Sign out?"
        message={pendingCount
          ? `${pendingCount} change(s) haven't reached the server yet and will be lost if you sign out now. Your other books are safe on the server.`
          : `Your books will be removed from this ${IS_WEB ? 'browser' : 'phone'}. They stay safe on the server and come back when you sign in.`}
        confirmLabel="Sign out"
        danger={pendingCount > 0}
        busy={signingOut}
        onConfirm={doSignOut}
        onCancel={() => setConfirmSignOut(false)}
      />
      <Dialog
        visible={Boolean(importing)}
        title="Import these books?"
        message={importing ? `${importing.plan.added} to add, ${importing.plan.updated} to update, and ${importing.plan.skipped} skipped because your copy is the same or newer.${importing.invalid ? ` ${importing.invalid} couldn't be read and will be left out.` : ''}` : ''}
        confirmLabel="Import"
        onConfirm={finishImport}
        onCancel={() => setImporting(null)}
      />
      <ChangePasswordDialog visible={passwordOpen} onClose={() => setPasswordOpen(false)} />
    </Screen>
  );
}

/**
 * The change-password dialog. In: visible, onClose. Needs the current password, so someone
 * holding an unlocked device can't change it. The server signs out the person's other devices.
 */
function ChangePasswordDialog({ visible, onClose }) {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  /** Clears the fields, so passwords don't stay in memory, and closes. */
  const close = () => {
    setCurrent('');
    setNext('');
    setError(null);
    onClose();
  };

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.request('POST', '/api/auth/password', { currentPassword: current, newPassword: next });
      close();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog visible={visible} title="Change password" confirmLabel="Change" busy={busy} onConfirm={submit} onCancel={close}>
      <Message text={error} />
      <Field label="Current password" value={current} onChangeText={setCurrent} secureTextEntry autoCapitalize="none" />
      <Field label="New password" value={next} onChangeText={setNext} secureTextEntry autoCapitalize="none" hint="At least 10 characters. This signs out your other devices, disconnects Nextcloud so you'd reconnect it afterward, and cancels any invite or reset codes you've made and not yet used." />
    </Dialog>
  );
}

const styles = StyleSheet.create({
  content: { padding: 12, paddingBottom: 40 },
  swatches: { flexDirection: 'row', flexWrap: 'wrap', marginTop: 14, rowGap: 12 },
  swatch: { width: '33.33%', alignItems: 'center' },
  swatchBox: { width: 76, height: 52, borderRadius: 10, borderWidth: 2, alignItems: 'center', justifyContent: 'center' },
  swatchDot: { width: 26, height: 26, borderRadius: 13, alignItems: 'center', justifyContent: 'center' },
  swatchName: { fontSize: 13, marginTop: 4 },
  body: { fontSize: 15, marginBottom: 12 },
  name: { fontSize: 16, fontWeight: '600' },
  twoButtons: { flexDirection: 'row', gap: 8, marginBottom: 6 },
  half: { flex: 1 },
  gap: { marginBottom: 8 },
  linkRow: { flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 48 },
  linkLabel: { flex: 1, fontSize: 16 },
  version: { textAlign: 'center', fontSize: 13, marginTop: 8 },
});
