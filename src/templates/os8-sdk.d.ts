/**
 * Type definitions for the `window.os8` SDK exposed inside an OS8 external app.
 *
 * Spec §6.3.3. Each method is optional — its presence depends on what the
 * manifest's `permissions.os8_capabilities` declared. Calling a method that
 * isn't on `window.os8` (because the manifest didn't request it) is a
 * `TypeError`. Calling a method whose required capability fails the
 * server-side check (PR 1.7) gets a structured `403` thrown as
 * `{ status: 403, body: { error: 'capability not declared', required, declared } }`.
 *
 * This file is dropped into each installed external app's folder by PR 1.21
 * so IDEs (VS Code, Cursor) get autocomplete without an npm install round-trip.
 *
 * Example:
 *   if (window.os8?.blob?.write) {
 *     await window.os8.blob.write('hello', new Blob(['world']));
 *   }
 */

export {};

declare global {
  interface Window {
    os8: Os8Sdk;
  }
}

export interface Os8Sdk {
  blob?: BlobApi;
  db?: DbApi;

  imagegen?: RestWrapper;
  speak?: RestWrapper;
  youtube?: RestWrapper;
  x?: RestWrapper;

  telegram?: { send: (body: TelegramMessage) => Promise<{ ok: boolean }> };

  googleCalendar?: RestWrapper;
  googleDrive?: RestWrapper;
  googleGmail?: RestWrapper;

  // mcp.<server>.<tool> — present when any mcp.* capability is declared.
  mcp?: <T = unknown>(server: string, tool: string, body?: unknown) => Promise<T>;
}

export interface BlobApi {
  read: (key: string) => Promise<Blob>;
  list: (prefix?: string) => Promise<{ keys: string[] }>;
  // Only present when `blob.readwrite` is declared.
  write?: (key: string, data: Blob | ArrayBuffer | string) => Promise<void>;
  delete?: (key: string) => Promise<void>;
}

export interface DbApi {
  query: <Row = Record<string, unknown>>(sql: string, params?: unknown[]) =>
    Promise<{ rows: Row[] }>;
  // Only present when `db.readwrite` is declared.
  execute?: (sql: string, params?: unknown[]) =>
    Promise<{ changes: number; lastInsertRowid: number }>;
}

export interface RestWrapper {
  get:  <T = unknown>(subpath?: string, query?: Record<string, string>) => Promise<T>;
  post: <T = unknown>(subpath: string, body?: unknown) => Promise<T>;
}

export interface TelegramMessage {
  text?: string;
  chatId?: string | number;
  // … forwards remaining fields per /api/telegram/send accept envelope
  [k: string]: unknown;
}
