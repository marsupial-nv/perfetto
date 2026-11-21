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

import {hasTracyMagic, manifestJsonForDryRun, tracyStandIn} from './tracy_file';

describe('hasTracyMagic', () => {
  it('recognises the three Tracy containers', () => {
    expect(hasTracyMagic(new Uint8Array([0x74, 0x72, 0xfd, 0x50, 1, 4]))).toBe(
      true,
    );
    expect(hasTracyMagic(new Uint8Array([0x74, 0x6c, 0x5a, 0x04]))).toBe(true);
    expect(hasTracyMagic(new Uint8Array([0x74, 0x5a, 0x73, 0x74]))).toBe(true);
  });

  it('rejects other and short inputs', () => {
    // A Perfetto proto trace, a JSON trace, a truncated magic, nothing.
    expect(hasTracyMagic(new Uint8Array([0x0a, 0x10, 0x08, 0x01]))).toBe(false);
    expect(hasTracyMagic(new Uint8Array([0x7b, 0x22, 0x74, 0x72]))).toBe(false);
    expect(hasTracyMagic(new Uint8Array([0x74, 0x72, 0xfd]))).toBe(false);
    expect(hasTracyMagic(new Uint8Array([]))).toBe(false);
  });
});

describe('tracyStandIn', () => {
  it('keeps the file name so the manifest still resolves', () => {
    const standIn = tracyStandIn(new File([], 'capture.tracy'));
    expect(standIn.name).toBe('capture.tracy');
    expect(standIn.size).toBeGreaterThan(0);
  });
});

describe('manifestJsonForDryRun', () => {
  it('drops align and keeps everything else', () => {
    const manifest = {
      perfetto_manifest: {
        version: 1,
        files: [
          {path: 'a.pftrace', machine: {name: 'm'}},
          {path: 'b.tracy', align: 'start'},
        ],
      },
    };
    expect(JSON.parse(manifestJsonForDryRun(JSON.stringify(manifest)))).toEqual(
      {
        perfetto_manifest: {
          version: 1,
          files: [{path: 'a.pftrace', machine: {name: 'm'}}, {path: 'b.tracy'}],
        },
      },
    );
  });

  it('copes with a manifest without files', () => {
    const json = JSON.stringify({perfetto_manifest: {version: 1}});
    expect(JSON.parse(manifestJsonForDryRun(json))).toEqual({
      perfetto_manifest: {version: 1},
    });
  });
});
