// screens/NextcloudScreen.js
// Connects a person's own Nextcloud, so their library can be saved there daily, and on
// request, as JSON and CSV. The app password is sent to the server once, kept encrypted
// there, and never shown again: this screen never receives it back.

import React, { useCallback, useEffect, useState } from 'react';
import { KeyboardAvoidingView, ScrollView, StyleSheet, Switch, Text, View } from 'react-native';
import Screen from '../components/Screen';
import { Button, Card, Dialog, Field, Message } from '../components/ui';
import { useBooks } from '../contexts/BooksContext';
import { useTheme } from '../contexts/ThemeContext';
import * as api from '../lib/api';
import { useRevealFocusedField } from '../lib/useRevealFocusedField';

/** The Nextcloud screen. */
export default function NextcloudScreen() {
  const { scrollRef, onScroll, reveal } = useRevealFocusedField();
  const { colors } = useTheme();
  const { syncNow } = useBooks();
  const [link, setLink] = useState(null);
  const [form, setForm] = useState({ baseUrl: '', username: '', appPassword: '' });
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);

  /** Runs a server action, showing its error and updating the status from its answer. */
  const run = useCallback(async (action) => {
    setBusy(true);
    setError(null);
    try {
      setLink(await action());
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => { run(() => api.request('GET', '/api/nextcloud')); }, [run]);

  /** Saves the connection, then clears the password from this screen's memory. */
  const connect = async () => {
    await run(() => api.request('PUT', '/api/nextcloud', { ...form, dailyExport: true }));
    setForm((current) => ({ ...current, appPassword: '' }));
  };

  /** Syncs first, so an export made now includes the latest edits from this device. */
  const exportNow = async () => {
    await syncNow();
    await run(() => api.request('POST', '/api/nextcloud/export'));
  };

  return (
    <Screen title="Nextcloud" back>
      <KeyboardAvoidingView behavior="padding" style={styles.fill}>
        <ScrollView ref={scrollRef} onScroll={onScroll} scrollEventThrottle={32} contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
          <Message text={error} />
          {link?.connected ? (
            <Card>
              <Text style={[styles.strong, { color: colors.text }]}>Connected as {link.username}</Text>
              <Text style={[styles.text, { color: colors.muted }]}>Exports of your books go here. If you don't recognise this, tap Disconnect and change your password.</Text>
              <Text style={[styles.text, { color: colors.muted }]}>{link.baseUrl}</Text>
              <Text style={[styles.text, { color: colors.muted }]}>
                {link.lastExportAt ? `Last export: ${new Date(link.lastExportAt).toLocaleString()}` : 'No exports yet.'}
              </Text>
              {link.lastError ? <Message text={`Last attempt failed: ${link.lastError}`} /> : null}
              <View style={styles.switchRow}>
                <Text style={[styles.switchLabel, { color: colors.text }]}>Export every day</Text>
                <Switch
                  value={link.dailyExport}
                  accessibilityLabel="Export every day"
                  trackColor={{ true: colors.accent }}
                  onValueChange={(dailyExport) => run(() => api.request('PATCH', '/api/nextcloud', { dailyExport }))}
                />
              </View>
              <Button label="Export now" onPress={exportNow} busy={busy} style={styles.gap} />
              <Button label="Disconnect" kind="secondary" onPress={() => setConfirmRemove(true)} />
            </Card>
          ) : (
            <>
              <Text style={[styles.text, { color: colors.text }]}>
                Save a copy of your library to your own Nextcloud every day, as a JSON file and a spreadsheet-friendly CSV file. The last 7 days are kept, in a folder named Readeez.
              </Text>
              <Text style={[styles.text, { color: colors.muted }]}>
                In Nextcloud, open Personal settings, then Security, and create an app password. Use that here, not your normal password. Changing your Readeez password disconnects this, so anyone who had access can't keep receiving your books.
              </Text>
              <Field onFocus={reveal} label="Nextcloud address" value={form.baseUrl} onChangeText={(baseUrl) => setForm({ ...form, baseUrl })} placeholder="https://cloud.example.com" autoCapitalize="none" autoCorrect={false} keyboardType="url" />
              <Field onFocus={reveal} label="User name" value={form.username} onChangeText={(username) => setForm({ ...form, username })} autoCapitalize="none" autoCorrect={false} />
              <Field onFocus={reveal} label="App password" value={form.appPassword} onChangeText={(appPassword) => setForm({ ...form, appPassword })} secureTextEntry autoCapitalize="none" />
              <Button label="Connect" onPress={connect} busy={busy} />
            </>
          )}
        </ScrollView>
      </KeyboardAvoidingView>
      <Dialog
        visible={confirmRemove}
        title="Disconnect Nextcloud?"
        message="Daily exports will stop, and the server will erase your app password. Files already in your Nextcloud stay there."
        confirmLabel="Disconnect"
        danger
        onCancel={() => setConfirmRemove(false)}
        onConfirm={() => {
          setConfirmRemove(false);
          setForm({ baseUrl: '', username: '', appPassword: '' });
          run(() => api.request('DELETE', '/api/nextcloud'));
        }}
      />
    </Screen>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  content: { padding: 14, paddingBottom: 40 },
  strong: { fontSize: 16, fontWeight: '600', marginBottom: 4 },
  text: { fontSize: 15, lineHeight: 21, marginBottom: 12 },
  switchRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', minHeight: 48, marginBottom: 8 },
  switchLabel: { fontSize: 16 },
  gap: { marginBottom: 8 },
});
