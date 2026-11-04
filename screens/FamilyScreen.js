// screens/FamilyScreen.js
// Admin only: family accounts, invite and reset codes, and disabling accounts. The server
// enforces admin access on every request, so hiding the Settings link is a convenience,
// not the protection. A code appears once and can't be recovered, so the person must confirm
// they've saved it before the dialog closes.

import React, { useCallback, useEffect, useState } from 'react';
import { FlatList, Share, StyleSheet, Text, View } from 'react-native';
import Screen from '../components/Screen';
import { Button, Card, Dialog, Message, Segmented } from '../components/ui';
import { useAuth } from '../contexts/AuthContext';
import { useTheme } from '../contexts/ThemeContext';
import * as api from '../lib/api';

const ROLES = [{ id: 'member', label: 'Member' }, { id: 'admin', label: 'Admin' }];

/** The family accounts screen. */
export default function FamilyScreen() {
  const { colors } = useTheme();
  const { user: me } = useAuth();
  const [users, setUsers] = useState([]);
  const [error, setError] = useState(null);
  const [inviteOpen, setInviteOpen] = useState(false);
  const [role, setRole] = useState('member');
  // The code on show: { title, code, note }.
  const [shownCode, setShownCode] = useState(null);
  // The account awaiting confirmation of a disable or re-enable.
  const [toggling, setToggling] = useState(null);

  /** Reloads the list. */
  const load = useCallback(async () => {
    try {
      setUsers((await api.request('GET', '/api/admin/users')).users);
    } catch (err) {
      setError(err.message);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  /** Creates an invite and shows its code. */
  const createInvite = async () => {
    setInviteOpen(false);
    setError(null);
    try {
      const { code, expiresInDays } = await api.request('POST', '/api/admin/invites', { role });
      setShownCode({ title: 'Invite code', code, note: `Give this to the new ${role}. They choose "I have an invite code" when they open Readeez. It works once and expires in ${expiresInDays} days.` });
    } catch (err) {
      setError(err.message);
    }
  };

  /** Creates a password-reset code and shows it. In: the account. */
  const createReset = async (account) => {
    setError(null);
    try {
      const { code, expiresInHours } = await api.request('POST', `/api/admin/users/${account.id}/reset-code`);
      setShownCode({ title: `Reset code for ${account.displayName}`, code, note: `They choose "I have a password reset code" on the sign-in screen. It works once and expires in ${expiresInHours} hours.` });
    } catch (err) {
      setError(err.message);
    }
  };

  /** Applies the confirmed disable or re-enable, then reloads the list. */
  const applyToggle = async () => {
    const account = toggling;
    setToggling(null);
    setError(null);
    try {
      await api.request('PATCH', `/api/admin/users/${account.id}`, { disabled: !account.disabled });
      await load();
    } catch (err) {
      setError(err.message);
    }
  };

  return (
    <Screen title="Family accounts" back>
      <FlatList
        data={users}
        keyExtractor={(account) => account.id}
        contentContainerStyle={styles.content}
        ListHeaderComponent={(
          <>
            <Message text={error} />
            <Button label="Invite someone" onPress={() => setInviteOpen(true)} style={styles.invite} />
          </>
        )}
        renderItem={({ item }) => (
          <Card>
            <Text style={[styles.name, { color: colors.text }]}>{item.displayName}{item.id === me.id ? ' (you)' : ''}</Text>
            <Text style={[styles.detail, { color: colors.muted }]}>{item.email}</Text>
            <Text style={[styles.detail, { color: colors.muted }]}>
              {item.role === 'admin' ? 'Admin' : 'Member'} · {item.bookCount} {item.bookCount === 1 ? 'book' : 'books'}{item.disabled ? ' · Disabled' : ''}
            </Text>
            <View style={styles.buttons}>
              <Button label="Reset code" kind="secondary" onPress={() => createReset(item)} style={styles.half} />
              {item.id !== me.id ? (
                <Button label={item.disabled ? 'Enable' : 'Disable'} kind="secondary" onPress={() => setToggling(item)} style={styles.half} />
              ) : null}
            </View>
          </Card>
        )}
      />

      <Dialog visible={inviteOpen} title="Invite someone" message="Admins can manage accounts and see server status. They can't read anyone's books." confirmLabel="Create code" onConfirm={createInvite} onCancel={() => setInviteOpen(false)}>
        <Segmented options={ROLES} value={role} onChange={setRole} />
      </Dialog>

      {/* One button only, with wording that makes the person confirm the code is saved. */}
      <Dialog visible={Boolean(shownCode)} title={shownCode?.title} confirmLabel="I've saved it" onConfirm={() => setShownCode(null)}>
        <Text selectable style={[styles.code, { color: colors.text, borderColor: colors.border }]}>{shownCode?.code}</Text>
        <Text style={[styles.note, { color: colors.text }]}>{shownCode?.note}</Text>
        <Text style={[styles.note, styles.warning, { color: colors.text }]}>This code won't be shown again.</Text>
        <Button label="Share code" kind="secondary" onPress={() => Share.share({ message: shownCode.code }).catch(() => {})} />
      </Dialog>

      <Dialog
        visible={Boolean(toggling)}
        title={toggling?.disabled ? `Enable ${toggling?.displayName}?` : `Disable ${toggling?.displayName}?`}
        message={toggling?.disabled ? 'They\'ll be able to sign in again.' : 'They\'ll be signed out everywhere and can\'t sign in. Their books are kept.'}
        confirmLabel={toggling?.disabled ? 'Enable' : 'Disable'}
        danger={!toggling?.disabled}
        onConfirm={applyToggle}
        onCancel={() => setToggling(null)}
      />
    </Screen>
  );
}

const styles = StyleSheet.create({
  content: { padding: 12, paddingBottom: 40 },
  invite: { marginBottom: 12 },
  name: { fontSize: 16, fontWeight: '600' },
  detail: { fontSize: 14, marginTop: 2 },
  buttons: { flexDirection: 'row', gap: 8, marginTop: 10 },
  half: { flex: 1 },
  code: { fontSize: 20, fontWeight: '700', letterSpacing: 1, textAlign: 'center', borderWidth: 1, borderRadius: 10, paddingVertical: 14, marginBottom: 12, fontFamily: 'monospace' },
  note: { fontSize: 14, lineHeight: 20, marginBottom: 10 },
  warning: { fontWeight: '700' },
});
