// Copyright (C) 2026 The Android Open Source Project
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//      http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

// Wire format of the remote control channel: a page that embeds the UI in an
// iframe (or opened it as a popup) drives the view with window.postMessage.
//
//   embedder -> UI   {perfettoRemote: {seq: 7, commands: [ ... ]}}
//   UI -> embedder   {perfettoRemote: {type: 'result', seq: 7, ...}}
//
// The UI answers every message it accepts, and only messages from allowed
// origins are accepted (see isAllowedOrigin). An empty command list is a ping.
// Timestamps are nanoseconds in the trace's own clock, passed as decimal
// strings because they do not fit a JS number.

export const REMOTE_KEY = 'perfettoRemote';

export type RemoteCommand =
  // Fit the viewport to [start, end].
  | {op: 'zoom'; start: bigint; end: bigint}
  // Select a row of a SQL table (default: slice) and show its details.
  | {op: 'select'; table: string; id: number; scroll: boolean}
  // Pin the tracks that show these track ids (slice.track_id). With replace,
  // tracks pinned by an earlier command are unpinned first.
  | {op: 'pin_tracks'; trackIds: number[]; replace: boolean}
  // Show the rows of a query (ts, dur, name) as a pinned track. It replaces
  // the track added earlier under the same key; tracks of other keys stay.
  // With uniform, all slices get one colour instead of one per name.
  | {
      op: 'debug_track';
      key: string;
      title: string;
      sql: string;
      uniform: boolean;
    }
  // Put a flag (ts) or a flagged range (start, end) on the timeline. Notes
  // with the same id replace each other.
  | {
      op: 'note';
      id: string;
      text: string;
      color?: string;
      start: bigint;
      end?: bigint;
    }
  // Select the area [start, end] on the tracks of these track ids; without
  // ids, on every pinned track. Highlights a region under investigation.
  | {op: 'select_area'; start: bigint; end: bigint; trackIds: number[]}
  // Use this colour theme for this page load, without changing the user's
  // own theme setting.
  | {op: 'theme'; theme: 'dark' | 'light'}
  // Drop the current selection, leaving tracks, pins and notes in place.
  | {op: 'deselect'}
  // Remove everything earlier commands added: pins, tracks, notes, selection.
  | {op: 'clear'};

export interface RemoteRequest {
  readonly seq: number;
  readonly commands: RemoteCommand[];
}

export interface RemoteStatus {
  // 'no_trace' until a trace is loaded and its tracks exist.
  readonly state: 'no_trace' | 'ready';
  readonly traceTitle?: string;
  readonly traceStart?: string;
  readonly traceEnd?: string;
  readonly visibleStart?: string;
  readonly visibleEnd?: string;
}

export type RemoteReply =
  | ({type: 'status'} & RemoteStatus)
  | ({
      type: 'result';
      seq: number;
      // One entry per command: undefined if it was applied, else why not.
      errors: Array<string | undefined>;
    } & RemoteStatus);

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null && !Array.isArray(x);
}

function toNs(x: unknown): bigint | undefined {
  if (typeof x === 'bigint') return x;
  if (typeof x === 'number' && Number.isSafeInteger(x)) return BigInt(x);
  if (typeof x === 'string' && /^-?\d{1,19}$/.test(x)) return BigInt(x);
  return undefined;
}

function toId(x: unknown): number | undefined {
  if (typeof x === 'number' && Number.isSafeInteger(x) && x >= 0) return x;
  if (typeof x === 'string' && /^\d{1,15}$/.test(x)) return Number(x);
  return undefined;
}

// Table names end up in SQL, so only plain identifiers are accepted.
const IDENT = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const COLOR = /^#[0-9a-fA-F]{3,8}$/;
const MAX_SQL = 20000;
const MAX_TEXT = 400;
const MAX_TRACKS = 32;
const MAX_COMMANDS = 32;

// Returns the command, or a string saying what is wrong with it.
export function parseCommand(raw: unknown): RemoteCommand | string {
  if (!isRecord(raw) || typeof raw.op !== 'string') return 'not a command';
  switch (raw.op) {
    case 'zoom': {
      const start = toNs(raw.start);
      const end = toNs(raw.end);
      if (start === undefined || end === undefined) return 'zoom: bad range';
      if (end < start) return 'zoom: end before start';
      return {op: 'zoom', start, end};
    }
    case 'select': {
      const id = toId(raw.id);
      const table = raw.table === undefined ? 'slice' : raw.table;
      if (id === undefined) return 'select: bad id';
      if (typeof table !== 'string' || !IDENT.test(table)) {
        return 'select: bad table';
      }
      return {op: 'select', table, id, scroll: raw.scroll !== false};
    }
    case 'pin_tracks': {
      const ids = raw.track_ids;
      if (!Array.isArray(ids) || ids.length > MAX_TRACKS) {
        return 'pin_tracks: bad track_ids';
      }
      const trackIds: number[] = [];
      for (const x of ids) {
        const id = toId(x);
        if (id === undefined) return 'pin_tracks: bad track id';
        trackIds.push(id);
      }
      return {op: 'pin_tracks', trackIds, replace: raw.replace !== false};
    }
    case 'debug_track': {
      const {title, sql} = raw;
      const key = raw.key === undefined ? 'main' : raw.key;
      if (
        typeof sql !== 'string' ||
        sql.trim() === '' ||
        sql.length > MAX_SQL
      ) {
        return 'debug_track: bad sql';
      }
      if (typeof title !== 'string' || title.length > MAX_TEXT) {
        return 'debug_track: bad title';
      }
      if (typeof key !== 'string' || !IDENT.test(key)) {
        return 'debug_track: bad key';
      }
      return {
        op: 'debug_track',
        key,
        title,
        sql,
        uniform: raw.uniform === true,
      };
    }
    case 'note': {
      const start = toNs(raw.start);
      const end = raw.end === undefined ? undefined : toNs(raw.end);
      const {text, color} = raw;
      const id = raw.id === undefined ? 'remote' : raw.id;
      if (start === undefined) return 'note: bad start';
      if (raw.end !== undefined && (end === undefined || end < start)) {
        return 'note: bad end';
      }
      if (typeof text !== 'string' || text.length > MAX_TEXT) {
        return 'note: bad text';
      }
      if (typeof id !== 'string' || !IDENT.test(id)) return 'note: bad id';
      if (
        color !== undefined &&
        (typeof color !== 'string' || !COLOR.test(color))
      ) {
        return 'note: bad color';
      }
      return {op: 'note', id, text, color, start, end};
    }
    case 'select_area': {
      const start = toNs(raw.start);
      const end = toNs(raw.end);
      const ids = raw.track_ids === undefined ? [] : raw.track_ids;
      if (start === undefined || end === undefined || end < start) {
        return 'select_area: bad range';
      }
      if (!Array.isArray(ids) || ids.length > MAX_TRACKS) {
        return 'select_area: bad track_ids';
      }
      const trackIds: number[] = [];
      for (const x of ids) {
        const id = toId(x);
        if (id === undefined) return 'select_area: bad track id';
        trackIds.push(id);
      }
      return {op: 'select_area', start, end, trackIds};
    }
    case 'theme':
      if (raw.theme !== 'dark' && raw.theme !== 'light') {
        return 'theme: bad theme';
      }
      return {op: 'theme', theme: raw.theme};
    case 'deselect':
      return {op: 'deselect'};
    case 'clear':
      return {op: 'clear'};
    default:
      return `unknown op ${raw.op.slice(0, 32)}`;
  }
}

export interface ParsedRequest {
  readonly seq: number;
  // In order: a command, or the reason it was rejected.
  readonly commands: Array<RemoteCommand | string>;
}

// Returns undefined when |data| is not addressed to this channel at all.
export function parseRequest(data: unknown): ParsedRequest | undefined {
  if (!isRecord(data) || !isRecord(data[REMOTE_KEY])) return undefined;
  const body = data[REMOTE_KEY];
  const seq = typeof body.seq === 'number' ? body.seq : 0;
  const raw = Array.isArray(body.commands) ? body.commands : [];
  return {seq, commands: raw.slice(0, MAX_COMMANDS).map(parseCommand)};
}

function isLoopback(hostname: string): boolean {
  return (
    hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]'
  );
}

// Who may drive the UI:
// - a page of the same origin as the UI;
// - a page on the host that serves the UI (any port), and any loopback page
//   when the UI itself is on loopback: the same rule as for ?rpc_url=;
// - the origin of the trace processor the UI is attached to via ?rpc_url=
//   (the service that hands out the engine also embeds the UI).
export function isAllowedOrigin(
  origin: string,
  uiOrigin: string,
  rpcUrl?: string,
): boolean {
  let from: URL;
  let ui: URL;
  try {
    from = new URL(origin);
    ui = new URL(uiOrigin);
  } catch {
    return false;
  }
  if (from.protocol !== 'http:' && from.protocol !== 'https:') return false;
  if (from.origin === ui.origin) return true;
  if (from.hostname === ui.hostname) return true;
  if (isLoopback(from.hostname) && isLoopback(ui.hostname)) return true;
  if (rpcUrl !== undefined) {
    try {
      if (new URL(rpcUrl).origin === from.origin) return true;
    } catch {
      return false;
    }
  }
  return false;
}
