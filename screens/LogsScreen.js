// screens/LogsScreen.js
// Admin only: the server's recent log lines, newest first, with a filter for warnings and errors. It
// holds what's happened since the server last started. The terminal admin panel reads Docker's longer
// history. The server enforces admin access on the request.

import React, { useCallback, useEffect, useState } from 'react';
import { FlatList, RefreshControl, StyleSheet, Text, View } from 'react-native';
import Screen from '../components/Screen';
import { Message, Segmented } from '../components/ui';
import { useTheme } from '../contexts/ThemeContext';
import * as api from '../lib/api';

const LEVELS = [
  { id: 'info', label: 'All' },
  { id: 'warn', label: 'Warnings' },
  { id: 'error', label: 'Errors' },
];

/** The logs screen. Pull down to refresh. */
export default function LogsScreen() {
  const { colors } = useTheme();
  const [level, setLevel] = useState('info');
  const [lines, setLines] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  /** Loads the lines for the chosen filter. */
  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setLines((await api.request('GET', `/api/admin/logs?level=${level}&limit=300`)).lines);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [level]);

  useEffect(() => { load(); }, [load]);

  return (
    <Screen title="Server logs" back>
      <View style={styles.filter}>
        <Segmented options={LEVELS} value={level} onChange={setLevel} />
      </View>
      <FlatList
        data={lines}
        keyExtractor={(line, index) => `${index}`}
        contentContainerStyle={styles.list}
        refreshControl={<RefreshControl refreshing={loading} onRefresh={load} colors={[colors.accent]} tintColor={colors.accent} />}
        ListHeaderComponent={<Message text={error} />}
        ListEmptyComponent={!loading && !error ? <Text style={[styles.none, { color: colors.muted }]}>Nothing to show.</Text> : null}
        renderItem={({ item }) => (
          <Text selectable style={[styles.line, { color: colors.text, borderColor: colors.border }]}>{item}</Text>
        )}
      />
    </Screen>
  );
}

const styles = StyleSheet.create({
  filter: { paddingHorizontal: 12, paddingBottom: 8 },
  list: { paddingHorizontal: 12, paddingBottom: 32 },
  line: { fontFamily: 'monospace', fontSize: 12, lineHeight: 17, paddingVertical: 6, borderBottomWidth: StyleSheet.hairlineWidth },
  none: { textAlign: 'center', marginTop: 28, fontSize: 15 },
});
