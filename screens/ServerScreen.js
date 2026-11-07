// screens/ServerScreen.js
// Admin only: the running version and any update, the last backup, Back up now and Update buttons,
// request counters, and a link to the logs. The buttons only ask the server's host helper to run the
// normal scripts (server/host-agent.sh), so their safety checks still apply. Restores stay in the
// terminal admin panel, because a restore replaces the database this screen is reading from. The server
// enforces admin access on every request.

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useNavigation } from '@react-navigation/native';
import Ionicons from '@expo/vector-icons/Ionicons';
import Screen from '../components/Screen';
import { Button, Card, Dialog, Field, Message, SectionTitle } from '../components/ui';
import { useTheme } from '../contexts/ThemeContext';
import * as api from '../lib/api';
import appConfig from '../app.json';

const POLL_MS = 4000;
const JOB_NAMES = { backup: 'Backup', update: 'Update' };

/** A labelled line of information. In: label and value. */
function Row({ label, value }) {
  const { colors } = useTheme();
  return (
    <View style={styles.row}>
      <Text style={[styles.label, { color: colors.muted }]}>{label}</Text>
      <Text style={[styles.value, { color: colors.text }]} selectable>{value}</Text>
    </View>
  );
}

/**
 * A status line with an icon and a word, so the state doesn't rest on colour alone.
 * In: ok, text, and pending (shows a clock for something not finished yet, rather than a tick).
 */
function StatusLine({ ok, text, pending = false }) {
  const { colors } = useTheme();
  const icon = pending ? 'time-outline' : ok ? 'checkmark-circle' : 'alert-circle';
  const iconColor = pending ? colors.muted : ok ? '#2E7D32' : '#C62828';
  return (
    <View style={styles.status}>
      <Ionicons name={icon} size={20} color={iconColor} />
      <Text style={[styles.statusText, { color: colors.text }]}>{text}</Text>
    </View>
  );
}

/**
 * Turns seconds into a short phrase, such as "3 days" or "5 hours".
 * In: seconds. Out: text.
 */
function formatUptime(seconds) {
  if (seconds >= 86400) return `${Math.floor(seconds / 86400)} days`;
  if (seconds >= 3600) return `${Math.floor(seconds / 3600)} hours`;
  return `${Math.floor(seconds / 60)} minutes`;
}

/** The server screen. */
export default function ServerScreen() {
  const navigation = useNavigation();
  const { colors } = useTheme();
  const [status, setStatus] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [updateOpen, setUpdateOpen] = useState(false);
  const [typed, setTyped] = useState('');
  // Set after asking for a job, so the server restarting during an update reads as expected progress.
  const watching = useRef(false);

  /** Reloads the status. While a job is being watched, a failed request means the server's restarting. */
  const load = useCallback(async () => {
    try {
      const next = await api.request('GET', '/api/admin/status');
      setStatus(next);
      setError(null);
      if (next.job?.status === 'succeeded' || next.job?.status === 'failed') watching.current = false;
    } catch (err) {
      if (watching.current) setError('The server is restarting. This is normal during an update.');
      else setError(err.message);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  // Refreshes every few seconds while a job is unfinished. The cleanup stops the timer on leaving.
  const jobActive = status?.job?.status === 'queued' || status?.job?.status === 'running';
  useEffect(() => {
    if (!jobActive && !watching.current) return undefined;
    const timer = setInterval(load, POLL_MS);
    return () => clearInterval(timer);
  }, [jobActive, load]);

  /**
   * Asks the host helper to run a job.
   * In: the request body. Side effects: queues a backup or update on the server.
   */
  const startJob = async (body) => {
    setBusy(true);
    setError(null);
    try {
      await api.request('POST', '/api/admin/jobs', body);
      watching.current = true;
      await load();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  /** Starts the update after the person retypes the confirmation word. */
  const confirmUpdate = async () => {
    setUpdateOpen(false);
    setTyped('');
    await startJob({ kind: 'update', version: `v${status.latestVersion}`, confirm: 'UPDATE' });
  };

  const backup = status?.lastBackup;
  const job = status?.job;
  const metrics = status?.metrics;
  return (
    <Screen title="Server" back>
      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        <Message text={error} />
        {status ? (
          <>
            <SectionTitle>Version</SectionTitle>
            <Card>
              <Row label="Server" value={status.version} />
              <Row label="This app" value={appConfig.expo.version} />
              <Row label="Newest release" value={status.latestVersion || 'Couldn\'t check'} />
              {status.updateAvailable ? (
                <Button
                  label={`Update server to v${status.latestVersion}`}
                  onPress={() => setUpdateOpen(true)}
                  disabled={jobActive || !status.agentRunning}
                  busy={busy}
                />
              ) : null}
            </Card>

            <SectionTitle>Backup</SectionTitle>
            <Card>
              {backup ? (
                <>
                  <StatusLine ok={backup.ok && backup.uploaded} text={!backup.ok ? 'Failed' : backup.uploaded ? 'Succeeded' : 'Saved on the server only'} />
                  <Row label="Finished" value={new Date(backup.finishedAt).toLocaleString()} />
                  {backup.fileName ? <Row label="File" value={backup.fileName} /> : null}
                  {backup.message ? <Row label="Details" value={backup.message} /> : null}
                  {!backup.ok && status.lastGoodBackupAt ? <Row label="Last good backup" value={new Date(status.lastGoodBackupAt).toLocaleString()} /> : null}
                </>
              ) : (
                <Text style={[styles.body, { color: colors.text }]}>No backup has run yet.</Text>
              )}
              <Button label="Back up now" kind="secondary" onPress={() => startJob({ kind: 'backup' })} disabled={jobActive || !status.agentRunning} busy={busy} />
            </Card>

            {job ? (
              <>
                <SectionTitle>Last job</SectionTitle>
                <Card>
                  <StatusLine
                    ok={job.status === 'succeeded'}
                    pending={jobActive}
                    text={`${JOB_NAMES[job.kind] || job.kind}${job.version ? ` to ${job.version}` : ''}: ${job.status === 'queued' ? 'waiting to start (within a minute)' : job.status}`}
                  />
                  {job.output ? <Text selectable style={[styles.output, { color: colors.muted }]} numberOfLines={12}>{job.output.slice(-1200)}</Text> : null}
                </Card>
              </>
            ) : null}

            {!status.agentRunning ? (
              <Card>
                <StatusLine ok={false} text="The server's helper isn't running" />
                <Text style={[styles.body, { color: colors.text }]}>
                  Back up now and Update need it. On the server, run server/admin.sh and choose "Schedule nightly backups and the helper". Restores are always done there.
                </Text>
              </Card>
            ) : null}

            <SectionTitle>Activity since the last restart</SectionTitle>
            <Card>
              <Row label="Running for" value={formatUptime(metrics.uptimeSeconds)} />
              <Row label="Requests" value={`${metrics.requests}, averaging ${metrics.averageMs} ms`} />
              <Row label="Errors" value={`${metrics.serverErrors} server, ${metrics.clientErrors} refused requests`} />
              <Row label="Family" value={`${status.users} ${status.users === 1 ? 'account' : 'accounts'}, ${status.books} ${status.books === 1 ? 'book' : 'books'}`} />
              <Pressable onPress={() => navigation.navigate('Logs')} accessibilityRole="button" style={styles.link}>
                <Ionicons name="document-text-outline" size={20} color={colors.muted} />
                <Text style={[styles.linkLabel, { color: colors.text }]}>View logs</Text>
                <Ionicons name="chevron-forward" size={18} color={colors.muted} />
              </Pressable>
            </Card>
          </>
        ) : null}
      </ScrollView>

      <Dialog
        visible={updateOpen}
        title={`Update to v${status?.latestVersion}?`}
        message="The server backs up first, then restarts, so sync pauses for a minute or two. Books stay usable on phones, while the browser version waits for the server to return. Remember to give the family the matching app version."
        confirmLabel="Update"
        onConfirm={() => { if (typed === 'UPDATE') confirmUpdate(); }}
        onCancel={() => { setUpdateOpen(false); setTyped(''); }}
      >
        <Field label="Type UPDATE to confirm" value={typed} onChangeText={setTyped} autoCapitalize="characters" autoCorrect={false} />
      </Dialog>
    </Screen>
  );
}

const styles = StyleSheet.create({
  content: { padding: 12, paddingBottom: 40 },
  row: { marginBottom: 10 },
  label: { fontSize: 13 },
  value: { fontSize: 15, marginTop: 1 },
  body: { fontSize: 15, lineHeight: 21, marginBottom: 10 },
  output: { fontFamily: 'monospace', fontSize: 12, lineHeight: 17 },
  status: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 10 },
  statusText: { fontSize: 16, fontWeight: '600', flexShrink: 1 },
  link: { flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 48 },
  linkLabel: { flex: 1, fontSize: 16 },
});
