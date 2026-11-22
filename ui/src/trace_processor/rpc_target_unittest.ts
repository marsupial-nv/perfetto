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

import {
  isRpcUrlTrusted,
  rpcTargetFromPort,
  rpcTargetFromUrl,
} from './rpc_target';

describe('rpcTargetFromPort', () => {
  test('default layout', () => {
    const t = rpcTargetFromPort('9001');
    expect(t.statusUrl).toEqual('http://127.0.0.1:9001/status');
    expect(t.wsUrl).toEqual('ws://127.0.0.1:9001/websocket');
    expect(t.label).toEqual('127.0.0.1:9001');
  });
});

describe('rpcTargetFromUrl', () => {
  test('keeps the path prefix and adds a trailing slash', () => {
    const t = rpcTargetFromUrl('http://hub:8700/engines/g-1');
    expect(t?.httpBase).toEqual('http://hub:8700/engines/g-1/');
    expect(t?.statusUrl).toEqual('http://hub:8700/engines/g-1/status');
    expect(t?.wsUrl).toEqual('ws://hub:8700/engines/g-1/websocket');
    expect(t?.cspSources).toEqual(['http://hub:8700', 'ws://hub:8700']);
  });

  test('https maps to wss and the token is a query parameter', () => {
    const t = rpcTargetFromUrl('https://hub.example.com/engines/g-1/', 'a b');
    expect(t?.statusUrl).toEqual(
      'https://hub.example.com/engines/g-1/status?token=a%20b',
    );
    expect(t?.wsUrl).toEqual(
      'wss://hub.example.com/engines/g-1/websocket?token=a%20b',
    );
    expect(t?.label).toEqual('hub.example.com/engines/g-1/');
    expect(t?.label).not.toContain('a b');
  });

  test('rejects anything that is not plain http(s)', () => {
    expect(rpcTargetFromUrl('javascript:alert(1)')).toBeUndefined();
    expect(rpcTargetFromUrl('ws://hub/engines')).toBeUndefined();
    expect(rpcTargetFromUrl('not a url')).toBeUndefined();
    expect(rpcTargetFromUrl('http://user:pw@hub/')).toBeUndefined();
  });
});

describe('isRpcUrlTrusted', () => {
  test('same host on another port', () => {
    expect(
      isRpcUrlTrusted(
        'http://hub.corp:8700/engines/x/',
        'http://hub.corp:10000',
      ),
    ).toBe(true);
  });
  test('loopback names are interchangeable', () => {
    expect(
      isRpcUrlTrusted('http://127.0.0.1:8700/e/', 'http://localhost:10000'),
    ).toBe(true);
  });
  test('another host needs the flag', () => {
    expect(
      isRpcUrlTrusted('http://evil.example/e/', 'https://ui.perfetto.dev'),
    ).toBe(false);
    expect(
      isRpcUrlTrusted('http://127.0.0.1:8700/e/', 'https://ui.perfetto.dev'),
    ).toBe(false);
    expect(isRpcUrlTrusted('nope', 'https://ui.perfetto.dev')).toBe(false);
  });
});
