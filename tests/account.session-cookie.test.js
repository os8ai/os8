/**
 * Phase 5 PR 5.1 — AccountService session-cookie + share-installed-apps
 * unit tests.
 *
 * The startSignIn flow itself touches Electron's `shell.openExternal`
 * and a live HTTP server, so we don't exercise it here; we test the pure
 * read/write helpers around the new columns.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const Database = require('better-sqlite3');

vi.mock('electron', () => ({
  shell: { openExternal: vi.fn() },
}));

const AccountService = require('../src/services/account');

function makeDb() {
  const db = new Database(':memory:');
  // Mirror the Phase 5 user_account schema (PR 5.10 + schema.js update).
  db.exec(`
    CREATE TABLE user_account (
      id TEXT PRIMARY KEY DEFAULT 'local',
      os8_user_id TEXT,
      username TEXT,
      display_name TEXT,
      avatar_url TEXT,
      email TEXT,
      session_cookie TEXT,
      share_installed_apps INTEGER DEFAULT 1,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
  `);
  return db;
}

describe('AccountService — session cookie + share toggle (PR 5.1)', () => {
  let db;

  beforeEach(() => {
    db = makeDb();
  });

  afterEach(() => {
    db.close();
  });

  describe('saveAccount', () => {
    it('persists profile without touching session_cookie when opts omitted', () => {
      AccountService.saveAccount(db, {
        os8UserId: 'u_abc',
        username: 'leo',
        displayName: 'Leo',
        avatarUrl: 'https://os8.ai/avatar.png',
        email: 'leo@os8.ai',
      });
      const row = db.prepare('SELECT * FROM user_account WHERE id = ?').get('local');
      expect(row.os8_user_id).toBe('u_abc');
      expect(row.session_cookie).toBeNull();
      // Default share toggle is ON via column default.
      expect(row.share_installed_apps).toBe(1);
    });

    it('persists session_cookie when provided in opts', () => {
      AccountService.saveAccount(
        db,
        { os8UserId: 'u_abc', username: null, displayName: 'Leo', avatarUrl: null, email: 'leo@os8.ai' },
        { sessionCookie: 'next-auth.session-token=abc.def.ghi' }
      );
      const row = db.prepare('SELECT session_cookie FROM user_account WHERE id = ?').get('local');
      expect(row.session_cookie).toBe('next-auth.session-token=abc.def.ghi');
    });

    it('preserves prior session_cookie when re-saved without opts', () => {
      // Prime with a cookie.
      AccountService.saveAccount(
        db,
        { os8UserId: 'u_abc', username: null, displayName: 'Leo', avatarUrl: null, email: 'leo@os8.ai' },
        { sessionCookie: 'next-auth.session-token=cookie1' }
      );
      // Re-save with profile-only data — must not clobber the cookie.
      AccountService.saveAccount(db, {
        os8UserId: 'u_abc',
        username: 'leo-updated',
        displayName: 'Leo',
        avatarUrl: null,
        email: 'leo@os8.ai',
      });
      const row = db.prepare('SELECT session_cookie, username FROM user_account WHERE id = ?').get('local');
      expect(row.username).toBe('leo-updated');
      expect(row.session_cookie).toBe('next-auth.session-token=cookie1');
    });

    it('overwrites session_cookie when explicitly passed null', () => {
      AccountService.saveAccount(
        db,
        { os8UserId: 'u_abc', username: null, displayName: 'Leo', avatarUrl: null, email: 'leo@os8.ai' },
        { sessionCookie: 'next-auth.session-token=cookie1' }
      );
      AccountService.saveAccount(
        db,
        { os8UserId: 'u_abc', username: null, displayName: 'Leo', avatarUrl: null, email: 'leo@os8.ai' },
        { sessionCookie: null }
      );
      const row = db.prepare('SELECT session_cookie FROM user_account WHERE id = ?').get('local');
      expect(row.session_cookie).toBeNull();
    });
  });

  describe('getSessionCookie', () => {
    it('returns null when no row exists in user_account', () => {
      expect(AccountService.getSessionCookie(db)).toBeNull();
    });

    it('returns null when row exists but cookie has not been seeded', () => {
      AccountService.saveAccount(db, {
        os8UserId: 'u_abc',
        username: null,
        displayName: 'Leo',
        avatarUrl: null,
        email: 'leo@os8.ai',
      });
      expect(AccountService.getSessionCookie(db)).toBeNull();
    });

    it('returns the cookie when set and share toggle is ON', () => {
      AccountService.saveAccount(
        db,
        { os8UserId: 'u_abc', username: null, displayName: 'Leo', avatarUrl: null, email: 'leo@os8.ai' },
        { sessionCookie: 'next-auth.session-token=abc' }
      );
      expect(AccountService.getSessionCookie(db)).toBe('next-auth.session-token=abc');
    });

    it('returns null when share toggle is OFF (heartbeat opt-out)', () => {
      AccountService.saveAccount(
        db,
        { os8UserId: 'u_abc', username: null, displayName: 'Leo', avatarUrl: null, email: 'leo@os8.ai' },
        { sessionCookie: 'next-auth.session-token=abc' }
      );
      AccountService.setShareInstalledApps(db, false);
      expect(AccountService.getSessionCookie(db)).toBeNull();
    });

    it('returns null without throwing when user_account is missing the new columns', () => {
      // Pre-0.7.0 schema (no session_cookie / share_installed_apps).
      db.exec('DROP TABLE user_account');
      db.exec(`
        CREATE TABLE user_account (
          id TEXT PRIMARY KEY,
          os8_user_id TEXT,
          email TEXT
        );
      `);
      db.prepare('INSERT INTO user_account (id, os8_user_id, email) VALUES (?, ?, ?)').run(
        'local', 'u_abc', 'leo@os8.ai'
      );
      expect(() => AccountService.getSessionCookie(db)).not.toThrow();
      expect(AccountService.getSessionCookie(db)).toBeNull();
    });
  });

  describe('setShareInstalledApps', () => {
    beforeEach(() => {
      AccountService.saveAccount(
        db,
        { os8UserId: 'u_abc', username: null, displayName: 'Leo', avatarUrl: null, email: 'leo@os8.ai' },
        { sessionCookie: 'next-auth.session-token=abc' }
      );
    });

    it('setting to false clears the cached cookie', () => {
      AccountService.setShareInstalledApps(db, false);
      const row = db.prepare('SELECT session_cookie, share_installed_apps FROM user_account WHERE id = ?').get('local');
      expect(row.session_cookie).toBeNull();
      expect(row.share_installed_apps).toBe(0);
    });

    it('setting to true does NOT restore a cleared cookie (re-sign-in needed)', () => {
      AccountService.setShareInstalledApps(db, false);
      AccountService.setShareInstalledApps(db, true);
      const row = db.prepare('SELECT session_cookie, share_installed_apps FROM user_account WHERE id = ?').get('local');
      expect(row.session_cookie).toBeNull();
      expect(row.share_installed_apps).toBe(1);
    });
  });

  describe('getShareInstalledApps', () => {
    it('returns true (default) when no row exists', () => {
      expect(AccountService.getShareInstalledApps(db)).toBe(true);
    });

    it('returns true when toggle is ON', () => {
      AccountService.saveAccount(db, {
        os8UserId: 'u_abc', username: null, displayName: 'Leo', avatarUrl: null, email: 'leo@os8.ai',
      });
      expect(AccountService.getShareInstalledApps(db)).toBe(true);
    });

    it('returns false when toggle is OFF', () => {
      AccountService.saveAccount(db, {
        os8UserId: 'u_abc', username: null, displayName: 'Leo', avatarUrl: null, email: 'leo@os8.ai',
      });
      AccountService.setShareInstalledApps(db, false);
      expect(AccountService.getShareInstalledApps(db)).toBe(false);
    });

    it('returns true without throwing on a pre-0.7.0 schema', () => {
      db.exec('DROP TABLE user_account');
      db.exec(`CREATE TABLE user_account (id TEXT PRIMARY KEY)`);
      expect(() => AccountService.getShareInstalledApps(db)).not.toThrow();
      expect(AccountService.getShareInstalledApps(db)).toBe(true);
    });
  });

  describe('signOut', () => {
    it('drops the row and the cached cookie with it', () => {
      AccountService.saveAccount(
        db,
        { os8UserId: 'u_abc', username: null, displayName: 'Leo', avatarUrl: null, email: 'leo@os8.ai' },
        { sessionCookie: 'next-auth.session-token=abc' }
      );
      AccountService.signOut(db);
      expect(db.prepare('SELECT 1 FROM user_account WHERE id = ?').get('local')).toBeUndefined();
      expect(AccountService.getSessionCookie(db)).toBeNull();
    });
  });

  describe('getAccount', () => {
    it('returns share_installed_apps in the result row', () => {
      AccountService.saveAccount(db, {
        os8UserId: 'u_abc', username: 'leo', displayName: 'Leo', avatarUrl: null, email: 'leo@os8.ai',
      });
      const acc = AccountService.getAccount(db);
      expect(acc).not.toBeNull();
      expect(acc.share_installed_apps).toBe(1);
    });

    it('returns share_installed_apps = 0 after the toggle is cleared', () => {
      AccountService.saveAccount(db, {
        os8UserId: 'u_abc', username: 'leo', displayName: 'Leo', avatarUrl: null, email: 'leo@os8.ai',
      });
      AccountService.setShareInstalledApps(db, false);
      const acc = AccountService.getAccount(db);
      expect(acc.share_installed_apps).toBe(0);
    });
  });
});
