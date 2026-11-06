// screens/SignInScreen.js
// Everything before someone is signed in, on one screen with three modes: sign in, create
// an account with an invite code, and set a new password with a reset code. There's no
// public sign-up: an admin issues the codes. The server address is built into the app and
// stays out of the way, tucked behind a link for the rare case it needs changing.

import React, { useState } from 'react';
import { Image, KeyboardAvoidingView, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Background from '../components/Background';
import { Button, Field, Message } from '../components/ui';
import { useAuth } from '../contexts/AuthContext';
import { useTheme } from '../contexts/ThemeContext';
import * as api from '../lib/api';

const TITLES = { signIn: 'Sign in', invite: 'Create your account', reset: 'Set a new password' };

/** The sign-in screen. */
export default function SignInScreen() {
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const { signIn, redeem } = useAuth();
  const [mode, setMode] = useState('signIn');
  const [fields, setFields] = useState({ email: '', password: '', name: '', code: '' });
  const [server, setServer] = useState(api.getServerUrl());
  const [showServer, setShowServer] = useState(!api.getServerUrl());
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);
  const [busy, setBusy] = useState(false);

  const set = (name) => (value) => setFields((current) => ({ ...current, [name]: value }));

  /** Switches between the three modes, clearing messages and the password. */
  const switchMode = (next) => {
    setMode(next);
    setError(null);
    setNotice(null);
    set('password')('');
  };

  /**
   * Submits the current mode. Server messages are shown as they come: they're written for
   * people, and the sign-in failure message deliberately doesn't say which part was wrong.
   */
  const submit = async () => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      if (server.trim() !== api.getServerUrl()) await api.saveServerUrl(server);
      if (mode === 'signIn') {
        await signIn(fields.email, fields.password);
      } else if (mode === 'invite') {
        await redeem({ code: fields.code, email: fields.email, displayName: fields.name, password: fields.password });
      } else {
        await api.request('POST', '/api/auth/reset', { code: fields.code, password: fields.password });
        switchMode('signIn');
        setNotice('Password changed. Sign in with your new password.');
      }
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Background>
      <KeyboardAvoidingView behavior="padding" style={styles.fill}>
        <ScrollView contentContainerStyle={[styles.content, { paddingTop: insets.top + 40, paddingBottom: insets.bottom + 24 }]} keyboardShouldPersistTaps="handled">
          {/* The name directly below says what this is, so screen readers skip the picture. */}
          <Image source={require('../assets/logo-mark.png')} style={styles.logo} accessible={false} />
          <Text style={[styles.brand, { color: colors.accent }]} accessibilityRole="header">Readeez</Text>
          <Text style={[styles.heading, { color: colors.text }]}>{TITLES[mode]}</Text>
          <Message text={error} />
          <Message text={notice} kind="info" />

          {mode !== 'signIn' ? <Field label={mode === 'invite' ? 'Invite code' : 'Reset code'} value={fields.code} onChangeText={set('code')} autoCapitalize="characters" autoCorrect={false} placeholder="XXXX-XXXX-XXXX-XXXX" /> : null}
          {mode === 'invite' ? <Field label="Your name" value={fields.name} onChangeText={set('name')} autoCapitalize="words" autoComplete="name" /> : null}
          {mode !== 'reset' ? <Field label="Email" value={fields.email} onChangeText={set('email')} autoCapitalize="none" autoCorrect={false} autoComplete="email" keyboardType="email-address" /> : null}
          <Field
            label={mode === 'signIn' ? 'Password' : 'New password'}
            value={fields.password}
            onChangeText={set('password')}
            secureTextEntry
            autoCapitalize="none"
            autoComplete={mode === 'signIn' ? 'current-password' : 'new-password'}
            hint={mode === 'signIn' ? null : 'At least 10 characters.'}
            onSubmitEditing={submit}
          />
          {showServer ? <Field label="Server address" value={server} onChangeText={setServer} autoCapitalize="none" autoCorrect={false} keyboardType="url" placeholder="https://" /> : null}

          <Button label={TITLES[mode]} onPress={submit} busy={busy} />

          <View style={styles.links}>
            {mode === 'signIn' ? <TextLink label="I have an invite code" onPress={() => switchMode('invite')} /> : null}
            {mode === 'signIn' ? <TextLink label="I have a password reset code" onPress={() => switchMode('reset')} /> : null}
            {mode !== 'signIn' ? <TextLink label="Back to sign in" onPress={() => switchMode('signIn')} /> : null}
            {!showServer ? <TextLink label="Change server" onPress={() => setShowServer(true)} /> : null}
          </View>
          {mode === 'signIn' ? (
            <Text style={[styles.help, { color: colors.muted }]}>Forgot your password or need an account? Ask your family's Readeez admin for a code.</Text>
          ) : null}
        </ScrollView>
      </KeyboardAvoidingView>
    </Background>
  );
}

/** A text-only link. In: label and onPress. */
function TextLink({ label, onPress }) {
  const { colors } = useTheme();
  return (
    <Pressable onPress={onPress} accessibilityRole="button" style={styles.link}>
      <Text style={{ color: colors.accent, fontSize: 15 }}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  content: { paddingHorizontal: 24, flexGrow: 1, maxWidth: 480, width: '100%', alignSelf: 'center' },
  logo: { width: 72, height: 72, marginBottom: 12 },
  brand: { fontSize: 34, fontWeight: '800', marginBottom: 6 },
  heading: { fontSize: 20, fontWeight: '600', marginBottom: 20 },
  links: { marginTop: 14, alignItems: 'center' },
  link: { minHeight: 44, justifyContent: 'center', paddingHorizontal: 8 },
  help: { fontSize: 13, textAlign: 'center', marginTop: 10 },
});
