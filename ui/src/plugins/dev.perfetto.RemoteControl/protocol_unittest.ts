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

import {isAllowedOrigin, parseCommand, parseRequest} from './protocol';

describe('parseCommand', () => {
  test('zoom takes nanoseconds as strings beyond 2^53', () => {
    expect(
      parseCommand({
        op: 'zoom',
        start: '1795302750007862000',
        end: '1795302750907862001',
      }),
    ).toEqual({
      op: 'zoom',
      start: 1795302750007862000n,
      end: 1795302750907862001n,
    });
    expect(parseCommand({op: 'zoom', start: 5, end: 3})).toEqual(
      'zoom: end before start',
    );
    expect(parseCommand({op: 'zoom', start: '1e9', end: '2'})).toEqual(
      'zoom: bad range',
    );
    expect(parseCommand({op: 'zoom', start: 1.5, end: 2})).toEqual(
      'zoom: bad range',
    );
  });

  test('select defaults to the slice table and rejects SQL in the name', () => {
    expect(parseCommand({op: 'select', id: 42})).toEqual({
      op: 'select',
      table: 'slice',
      id: 42,
      scroll: true,
    });
    expect(parseCommand({op: 'select', id: 1, table: 'slice; drop'})).toEqual(
      'select: bad table',
    );
    expect(parseCommand({op: 'select', id: -1})).toEqual('select: bad id');
  });

  test('pin_tracks', () => {
    expect(parseCommand({op: 'pin_tracks', track_ids: [3, '4']})).toEqual({
      op: 'pin_tracks',
      trackIds: [3, 4],
      replace: true,
    });
    expect(parseCommand({op: 'pin_tracks', track_ids: [3, 'x']})).toEqual(
      'pin_tracks: bad track id',
    );
    expect(parseCommand({op: 'pin_tracks', track_ids: 3})).toEqual(
      'pin_tracks: bad track_ids',
    );
  });

  test('debug_track', () => {
    expect(
      parseCommand({op: 'debug_track', title: 't', sql: 'select 1'}),
    ).toEqual({
      op: 'debug_track',
      key: 'main',
      title: 't',
      sql: 'select 1',
      uniform: false,
    });
    expect(
      parseCommand({
        op: 'debug_track',
        key: 'earlier',
        uniform: true,
        title: 't',
        sql: 'select 1',
      }),
    ).toEqual({
      op: 'debug_track',
      key: 'earlier',
      title: 't',
      sql: 'select 1',
      uniform: true,
    });
    expect(parseCommand({op: 'debug_track', title: 't', sql: ' '})).toEqual(
      'debug_track: bad sql',
    );
    expect(parseCommand({op: 'debug_track', sql: 'select 1'})).toEqual(
      'debug_track: bad title',
    );
    expect(
      parseCommand({
        op: 'debug_track',
        key: 'a b',
        title: 't',
        sql: 'select 1',
      }),
    ).toEqual('debug_track: bad key');
    expect(parseCommand({op: 'deselect'})).toEqual({op: 'deselect'});
    expect(parseCommand({op: 'theme', theme: 'dark'})).toEqual({
      op: 'theme',
      theme: 'dark',
    });
    expect(parseCommand({op: 'theme', theme: 'pink'})).toEqual(
      'theme: bad theme',
    );
  });

  test('note', () => {
    expect(parseCommand({op: 'note', start: '10', text: 'hi'})).toEqual({
      op: 'note',
      id: 'remote',
      text: 'hi',
      color: undefined,
      start: 10n,
      end: undefined,
    });
    expect(
      parseCommand({op: 'note', start: '10', end: '5', text: 'hi'}),
    ).toEqual('note: bad end');
    expect(
      parseCommand({op: 'note', start: '10', text: 'hi', color: 'red'}),
    ).toEqual('note: bad color');
  });

  test('select_area', () => {
    expect(parseCommand({op: 'select_area', start: '5', end: '9'})).toEqual({
      op: 'select_area',
      start: 5n,
      end: 9n,
      trackIds: [],
    });
    expect(
      parseCommand({op: 'select_area', start: '5', end: '9', track_ids: [2]}),
    ).toEqual({op: 'select_area', start: 5n, end: 9n, trackIds: [2]});
    expect(parseCommand({op: 'select_area', start: '9', end: '5'})).toEqual(
      'select_area: bad range',
    );
  });

  test('unknown and malformed', () => {
    expect(parseCommand({op: 'eval', code: 'x'})).toEqual('unknown op eval');
    expect(parseCommand('zoom')).toEqual('not a command');
    expect(parseCommand(null)).toEqual('not a command');
  });
});

describe('parseRequest', () => {
  test('ignores messages for someone else', () => {
    expect(parseRequest('PING')).toBeUndefined();
    expect(parseRequest({perfetto: {buffer: 1}})).toBeUndefined();
    expect(parseRequest(undefined)).toBeUndefined();
  });

  test('an empty request is a ping', () => {
    expect(parseRequest({perfettoRemote: {seq: 3}})).toEqual({
      seq: 3,
      commands: [],
    });
  });

  test('keeps the order and reports bad commands in place', () => {
    const req = parseRequest({
      perfettoRemote: {seq: 9, commands: [{op: 'clear'}, {op: 'nope'}]},
    });
    expect(req).toEqual({seq: 9, commands: [{op: 'clear'}, 'unknown op nope']});
  });
});

describe('isAllowedOrigin', () => {
  const ui = 'http://hub.corp:10000';
  test('same origin and same host', () => {
    expect(isAllowedOrigin('http://hub.corp:10000', ui)).toBe(true);
    expect(isAllowedOrigin('http://hub.corp:8700', ui)).toBe(true);
  });
  test('loopback pages only when the UI is on loopback', () => {
    expect(
      isAllowedOrigin('http://127.0.0.1:8700', 'http://localhost:10000'),
    ).toBe(true);
    expect(isAllowedOrigin('http://localhost:5173', ui)).toBe(false);
  });
  test('the origin behind rpc_url', () => {
    expect(isAllowedOrigin('https://hub.example', ui)).toBe(false);
    expect(
      isAllowedOrigin(
        'https://hub.example',
        ui,
        'https://hub.example/engines/g/',
      ),
    ).toBe(true);
    expect(
      isAllowedOrigin(
        'https://other.example',
        ui,
        'https://hub.example/engines/g/',
      ),
    ).toBe(false);
  });
  test('rejects everything else', () => {
    expect(
      isAllowedOrigin('https://evil.example', 'https://ui.perfetto.dev'),
    ).toBe(false);
    expect(isAllowedOrigin('null', ui)).toBe(false);
    expect(isAllowedOrigin('file://', ui)).toBe(false);
  });
});
