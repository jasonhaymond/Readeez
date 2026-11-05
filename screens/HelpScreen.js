// screens/HelpScreen.js
// In-app help for family members who won't read a README. When a feature changes, this
// text must change with it: help describing something that's gone is worse than none.

import React from 'react';
import { ScrollView, StyleSheet, Text } from 'react-native';
import Screen from '../components/Screen';
import { Card, SectionTitle } from '../components/ui';
import { useAuth } from '../contexts/AuthContext';
import { useTheme } from '../contexts/ThemeContext';

const TOPICS = [
  ['Adding a book', 'Tap the + at the top of any screen. Only the title is required. The read date starts as today, and you can change it.'],
  ['Editing or deleting', 'Tap a book in your library. Change anything, then tap Save changes. Delete book is at the bottom. A deleted book only comes back by importing an earlier export.'],
  ['Authors and categories', 'A book can have several of each. Type a name and tap Done on the keyboard, or pick a suggestion. Tap a name to remove it.'],
  ['Rating', 'Tap a star to rate from 1 to 5. Tap the same star again to clear the rating. Ratings are optional.'],
  ['Finding books', 'The magnifying glass at the top of any screen searches titles, authors, categories and your notes. In your library, use Filter to narrow by rating, category or author.'],
  ['Using it offline', 'Everything works without a connection. Your changes are saved on your phone and sent to the server when you\'re back online. If a book was changed on two devices, the most recent change is kept.'],
  ['Who can see my books', 'Only you in the app. Your family\'s admin sees how many books you have, not what they are. An admin could still sign in as you by using a password reset code on your account. You\'d be signed out, and the next time you sign in you\'d see when reset codes were used. The dates stay in Settings. Anyone who runs the server can also read its database.'],
  ['Saving a copy', 'In Settings, use Share CSV or Share JSON to send your library anywhere, or connect your Nextcloud for a copy every day. Changing your password disconnects Nextcloud, so reconnect it afterward.'],
  ['Bringing a copy back', 'In Settings, tap Import a JSON export and pick the file. You\'ll see what it would change first. Books you\'ve edited more recently are left alone, and deleted books come back.'],
  ['Changing the look', 'In Settings, choose Light, Dark or System, and pick a colour or gradient theme. This only affects this phone.'],
  ['Forgot your password', 'Ask your family\'s Readeez admin for a reset code, then choose "I have a password reset code" on the sign-in screen.'],
  ['Signing out', 'Signing out removes your books from this phone, and they return when you sign back in. If changes are still waiting to sync, you\'ll be warned first, since those would be lost.'],
];

const ADMIN_TOPICS = [
  ['Adding family members', 'In Settings, open Family accounts and tap Invite someone. Give them the code. It\'s shown once, works once, and lasts 7 days. If someone is disabled or removed as an admin, their unused codes stop working.'],
  ['Someone is locked out', 'In Family accounts, tap Reset code next to their name and give them the code. It\'s shown once and lasts 24 hours. They\'ll see when reset codes were used, and it disconnects their Nextcloud, so only use one when they ask.'],
  ['Removing someone', 'Disable signs them out everywhere and blocks sign-in. Their books are kept, and you can enable the account again later.'],
  ['Updates and backups', 'Settings, then Server, shows your version and the last backup, with Back up now and Update buttons. Restores are done in the terminal admin panel: run server/admin.sh on the server.'],
  ['Server logs', 'Settings, then Server, then View logs shows recent server activity, which you can filter down to warnings and errors. Logs never include book contents or passwords.'],
];

/** The help screen. Admin topics appear only for admins. */
export default function HelpScreen() {
  const { colors } = useTheme();
  const { user } = useAuth();
  const renderTopics = (topics) => topics.map(([title, text]) => (
    <Card key={title}>
      <Text style={[styles.title, { color: colors.text }]}>{title}</Text>
      <Text style={[styles.text, { color: colors.text }]}>{text}</Text>
    </Card>
  ));
  return (
    <Screen title="Help" back>
      <ScrollView contentContainerStyle={styles.content}>
        {renderTopics(TOPICS)}
        {user?.role === 'admin' ? (
          <>
            <SectionTitle>For admins</SectionTitle>
            {renderTopics(ADMIN_TOPICS)}
          </>
        ) : null}
      </ScrollView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  content: { padding: 12, paddingBottom: 40 },
  title: { fontSize: 16, fontWeight: '600', marginBottom: 4 },
  text: { fontSize: 15, lineHeight: 21 },
});
