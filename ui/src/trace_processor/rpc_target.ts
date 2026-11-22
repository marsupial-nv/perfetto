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

// Where the HTTP+RPC trace processor lives. By default that is
// 127.0.0.1:<port>. With ?rpc_url= it is any http(s) URL that serves the same
// endpoints under a path prefix, e.g. a reverse proxy in front of a
// trace_processor_shell running on another machine:
//   https://hub.example.com/engines/g-1234/  ->  .../status, .../websocket
// An optional token is passed as ?token= on both, as websockets cannot carry
// an Authorization header.

export interface RpcTarget {
  // Base URL for HTTP endpoints, always with a trailing slash.
  readonly httpBase: string;
  // The websocket endpoint.
  readonly wsUrl: string;
  // HTTP URL of the /status endpoint.
  readonly statusUrl: string;
  // Short name shown to the user. Never contains the token.
  readonly label: string;
  // The origins that must be allowed by the Content Security Policy.
  readonly cspSources: ReadonlyArray<string>;
}

export function rpcTargetFromPort(port: string): RpcTarget {
  const hostAndPort = `127.0.0.1:${port}`;
  return {
    httpBase: `http://${hostAndPort}/`,
    wsUrl: `ws://${hostAndPort}/websocket`,
    statusUrl: `http://${hostAndPort}/status`,
    label: hostAndPort,
    cspSources: [`http://${hostAndPort}`, `ws://${hostAndPort}`],
  };
}

// Returns undefined if |rpcUrl| is not an absolute http(s) URL.
export function rpcTargetFromUrl(
  rpcUrl: string,
  token?: string,
): RpcTarget | undefined {
  let url: URL;
  try {
    url = new URL(rpcUrl);
  } catch {
    return undefined;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined;
  if (url.username !== '' || url.password !== '') return undefined;
  const path = url.pathname.endsWith('/') ? url.pathname : url.pathname + '/';
  const wsScheme = url.protocol === 'https:' ? 'wss:' : 'ws:';
  const query =
    token === undefined || token === ''
      ? ''
      : `?token=${encodeURIComponent(token)}`;
  const httpBase = `${url.protocol}//${url.host}${path}`;
  return {
    httpBase,
    wsUrl: `${wsScheme}//${url.host}${path}websocket${query}`,
    statusUrl: `${httpBase}status${query}`,
    label: `${url.host}${path}`,
    cspSources: [`${url.protocol}//${url.host}`, `${wsScheme}//${url.host}`],
  };
}

function isLoopbackHost(hostname: string): boolean {
  return (
    hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]'
  );
}

// Whether the UI served from |uiOrigin| may attach to |rpcUrl| without the
// user opting in through a flag. Following a link must not be enough to make
// the UI talk to an arbitrary server, so this holds only when the RPC server
// is on the machine that serves the UI (any port), or both are on loopback.
export function isRpcUrlTrusted(rpcUrl: string, uiOrigin: string): boolean {
  let rpc: URL;
  let ui: URL;
  try {
    rpc = new URL(rpcUrl);
    ui = new URL(uiOrigin);
  } catch {
    return false;
  }
  if (rpc.hostname === ui.hostname) return true;
  return isLoopbackHost(rpc.hostname) && isLoopbackHost(ui.hostname);
}
