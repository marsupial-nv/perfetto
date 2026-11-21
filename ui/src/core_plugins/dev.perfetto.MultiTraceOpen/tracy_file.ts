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

// Support for captures of the Tracy profiler (.tracy) in the multi-trace
// dialog.
//
// The dialog analyzes files with the in-browser (Wasm) trace processor, which
// cannot read Tracy captures: the importer wraps Tracy's native reader and
// only exists in a natively built trace_processor (GN arg
// enable_perfetto_tracy_importer). So Tracy captures are recognised here by
// their magic number and described statically instead of being parsed.

import type {FileAnalysis} from './multi_trace_types';

export const TRACY_FORMAT_NAME = 'Tracy';

// See TracyFileHeader.hpp in the Tracy sources: respectively the current
// container and the legacy LZ4 and Zstd ones. Keep in sync with
// IsTracyCapture() in
// src/trace_processor/plugins/tracy_importer/tracy_trace_reader.cc.
const TRACY_MAGICS: ReadonlyArray<ReadonlyArray<number>> = [
  [0x74, 0x72, 0xfd, 0x50], // 't' 'r' 253 'P'
  [0x74, 0x6c, 0x5a, 0x04], // 't' 'l' 'Z' 4
  [0x74, 0x5a, 0x73, 0x74], // 't' 'Z' 's' 't'
];

export function hasTracyMagic(head: Uint8Array): boolean {
  return TRACY_MAGICS.some(
    (magic) => head.length >= 4 && magic.every((byte, i) => head[i] === byte),
  );
}

export async function isTracyCapture(file: File): Promise<boolean> {
  const head = new Uint8Array(await file.slice(0, 4).arrayBuffer());
  return hasTracyMagic(head);
}

// What the Tracy importer does, as far as the dialog is concerned. A capture
// has no clock snapshots and a single machine, i.e. it looks like any other
// clockless trace (e.g. Chrome JSON):
//  - aligned by real clocks, it is placed by the wall-clock time of the start
//    of the capture (which Tracy records with a resolution of one second) if
//    the merged timeline can be reached from REALTIME, e.g. when merged with
//    a Perfetto trace;
//  - aligned to the start, its first zone coincides with the first event of
//    the other traces;
//  - aligned automatically, the importer picks between those two at load
//    time: real clocks if that makes the capture overlap the other traces in
//    time, otherwise (separate recordings) the start. The dialog cannot tell
//    which in advance as it cannot read the capture's time range;
//  - aligned by a fixed offset, its private clock (which reads the time since
//    the start of the capture) is pinned to the baseline at that offset.
export const TRACY_FILE_ANALYSIS: FileAnalysis = {
  format: TRACY_FORMAT_NAME,
  singleClock: true,
  privateClockOnly: true,
  builtinClockIds: [],
  singleMachine: true,
  embeddedMachineIds: [0],
  wholeFileAlignment: true,
};

export const TRACY_NEEDS_NATIVE_ENGINE_ERROR =
  'Tracy captures (.tracy) cannot be read by the trace processor built ' +
  'into this page. Run a native trace_processor built with the Tracy ' +
  'importer (GN arg enable_perfetto_tracy_importer=true) as ' +
  '"trace_processor_shell server http", let the UI use it (native ' +
  'acceleration) and add the file again.';

// A stand-in for a Tracy capture which the Wasm trace processor can load, for
// the merged dry-run: an empty JSON trace, which like a Tracy capture is a
// clockless single-machine trace, under the same file name so the manifest
// still refers to it. This lets the dry-run validate the manifest and check
// the other traces; it says nothing on where the events of the capture land.
export function tracyStandIn(file: File): File {
  return new File(['{"traceEvents":[]}'], file.name, {
    type: 'application/json',
  });
}

// The manifest for the merged dry-run: `align` only applies to files the
// importer places as a whole and is an error on any other, including the JSON
// stand-ins above, so it is left out. It does not affect what the dry-run can
// check anyway.
export function manifestJsonForDryRun(json: string): string {
  const root = JSON.parse(json);
  for (const file of root?.perfetto_manifest?.files ?? []) {
    delete file.align;
  }
  return JSON.stringify(root, null, 2);
}
