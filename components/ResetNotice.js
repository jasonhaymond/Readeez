// components/ResetNotice.js
// Tells someone when reset codes were used on their account. Those codes come from an admin, who could use
// one to sign in as them, so this is how they'd find out. Every date is listed, not just the newest, so a
// second "here's a code to fix it" can't hide a first. It reappears whenever there's a newer reset than
// this phone has shown, and after signing out and back in. The dates also stay in Settings. Dismissing it only
// remembers that on this phone, and the record itself lives on the server, where nothing in the app clears it.

import React, { useEffect, useState } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Dialog } from './ui';
import { useAuth } from '../contexts/AuthContext';

/** Shows the dialog when there's a reset this phone hasn't shown yet. */
export default function ResetNotice() {
  const { user } = useAuth();
  const [visible, setVisible] = useState(false);
  const resets = user?.adminResets || [];
  const newest = resets[0];
  // Inside the account's own storage, so signing out clears it and the next sign-in shows it again.
  const seenKey = `rz:${user?.id}:resetSeen`;

  useEffect(() => {
    if (!newest) return;
    AsyncStorage.getItem(seenKey).then((seen) => {
      if (seen !== newest) setVisible(true);
    });
  }, [newest, seenKey]);

  const dates = resets.map((at) => new Date(at).toLocaleString()).join('\n');
  return (
    <Dialog
      visible={visible}
      title="Password reset codes were used"
      message={`A reset code from your admin set your password on:\n\n${dates}\n\nWhoever used a code could sign in as you and see your books. If you did each of these yourself, there's nothing to do. If not, change your password in Settings and talk to your admin.`}
      confirmLabel="OK"
      onConfirm={() => {
        setVisible(false);
        AsyncStorage.setItem(seenKey, newest);
      }}
    />
  );
}
