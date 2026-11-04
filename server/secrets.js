// secrets.js
// Encrypts the one stored value the server must be able to read back: each
// person's Nextcloud app password. A stolen database dump alone doesn't reveal
// them, because the key lives in server/.env (SECRETS_KEY), not in the database.
// Uses AES-256-GCM, which also detects any tampering with the stored value.

const crypto = require('crypto');

/**
 * Turns SECRETS_KEY into the 32-byte key AES-256 needs.
 * In: nothing (reads the setting). Out: the key. Throws if the setting is missing,
 * so a misconfigured server fails loudly instead of encrypting with an empty key.
 */
function key() {
  if (!process.env.SECRETS_KEY) throw new Error('SECRETS_KEY is not set');
  return crypto.createHash('sha256').update(process.env.SECRETS_KEY).digest();
}

/**
 * Encrypts text for storage.
 * In: plain text. Out: 'v1:<iv>:<auth tag>:<ciphertext>', each part in base64.
 */
function encrypt(plain) {
  // A fresh random IV each time, so the same password never encrypts the same way.
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key(), iv);
  const data = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return ['v1', iv.toString('base64'), cipher.getAuthTag().toString('base64'), data.toString('base64')].join(':');
}

/**
 * Reverses encrypt().
 * In: the stored string. Out: the plain text. Throws on a wrong key or on altered
 * data. The tag length is fixed at its full 16 bytes because GCM would otherwise
 * accept a shortened tag, which makes forgery far easier.
 */
function decrypt(stored) {
  const [format, iv, tag, data] = String(stored).split(':');
  if (format !== 'v1') throw new Error('Unknown secret format');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key(), Buffer.from(iv, 'base64'), { authTagLength: 16 });
  decipher.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(data, 'base64')), decipher.final()]).toString('utf8');
}

module.exports = { encrypt, decrypt };
