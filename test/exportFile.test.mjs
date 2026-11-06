// test/exportFile.test.mjs
// Tests that plain-text copies of the library don't stay in the phone's temporary folder. Android's file and sharing
// modules are replaced with simple stand-ins, because they don't exist here.

import { beforeEach, expect, test, vi } from 'vitest';

const fake = vi.hoisted(() => ({ files: [], listing: [], writeFails: false, deleteFails: false, shareFails: false }));

vi.mock('expo-file-system', () => ({
  Paths: { cache: { list: () => fake.listing } },
  File: class {
    constructor(...parts) {
      this.uri = parts.join('/');
      this.exists = false;
      fake.files.push(this);
    }

    create() { this.exists = true; }

    write() {
      if (fake.writeFails) throw new Error('disk full');
    }

    delete() {
      if (fake.deleteFails) throw new Error('will not delete');
      this.exists = false;
    }
  },
}));
vi.mock('expo-sharing', () => ({
  isAvailableAsync: async () => true,
  shareAsync: async () => {
    if (fake.shareFails) throw new Error('share failed');
  },
}));
vi.mock('expo-document-picker', () => ({}));
vi.mock('../server/exportFormat', () => ({ toCsv: () => 'csv', toJson: () => 'json' }));

const { clearLeftoverFiles, shareExport } = await import('../lib/exportFile');

// A stand-in for something in the temporary folder, which notes whether it was deleted.
const item = (name) => ({ name, deleted: false, delete() { this.deleted = true; } });

beforeEach(() => {
  Object.assign(fake, { files: [], listing: [], writeFails: false, deleteFails: false, shareFails: false });
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

// A plain-text copy of the library mustn't outlive the share.
test('a finished share removes its file', async () => {
  await shareExport([], 'csv');
  expect(fake.files[0].exists).toBe(false);
});

test('a failed share removes its file and reports the failure', async () => {
  fake.shareFails = true;
  await expect(shareExport([], 'json')).rejects.toThrow('share failed');
  expect(fake.files[0].exists).toBe(false);
});

// A full disk can leave part of the library written, so that must go too.
test('a failed write removes the partial file and reports the failure', async () => {
  fake.writeFails = true;
  await expect(shareExport([], 'csv')).rejects.toThrow('disk full');
  expect(fake.files[0].exists).toBe(false);
});

// A share that worked mustn't be reported as a failure because of the tidying up afterward.
test('a file that will not delete does not fail the share', async () => {
  fake.deleteFails = true;
  await expect(shareExport([], 'csv')).resolves.toBeUndefined();
});

// Android can stop the app mid-share, so its own cleanup never runs. This is the safety net for that.
test('leftover exports and picker copies are removed, and nothing else', () => {
  const [csv, json, picker, other] = ['readeez-export-20261105.csv', 'readeez-export-20261101.json', 'DocumentPicker', 'http-cache'].map(item);
  fake.listing = [csv, json, picker, other];
  clearLeftoverFiles();
  expect([csv.deleted, json.deleted, picker.deleted, other.deleted]).toEqual([true, true, true, false]);
});

// This runs as the app opens, so a failure here mustn't stop it opening.
test('a failure while clearing does not throw', () => {
  fake.listing = [{ name: 'readeez-export-x.csv', delete() { throw new Error('will not delete'); } }];
  expect(() => clearLeftoverFiles()).not.toThrow();
});
