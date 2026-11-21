// Copyright (C) 2025 The Android Open Source Project
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

import type {Mock} from 'vitest';
import {ensureExists} from '../../base/assert';
import {MultiTraceController} from './multi_trace_controller';
import type {
  FileAnalysis,
  TraceFileAnalyzed,
  TraceFileAnalyzing,
  TraceFileError,
} from './multi_trace_types';
import type {AlignmentVerdict, TraceAnalyzer} from './trace_analyzer';

// Helper to create a mock TraceFileAnalyzed object for tests
function createMockAnalyzedTrace(
  uuid: string,
  format: string = 'Perfetto',
): TraceFileAnalyzed {
  return {
    uuid,
    file: new File([], `${uuid}.pftrace`),
    status: 'analyzed',
    analysis: {format},
  };
}

// Helper to create a mock TraceFileAnalyzing object for tests
function createMockAnalyzingTrace(
  uuid: string,
  progress: number = 0.5,
): TraceFileAnalyzing {
  return {
    uuid,
    file: new File([], `${uuid}.pftrace`),
    status: 'analyzing',
    progress,
  };
}

// Helper to create a mock TraceFileError object for tests
function createMockErrorTrace(uuid: string, error: string): TraceFileError {
  return {
    uuid,
    file: new File([], `${uuid}.pftrace`),
    status: 'error',
    error,
  };
}

// A fake TraceAnalyzer for testing purposes.
class FakeTraceAnalyzer implements TraceAnalyzer {
  private results = new Map<string, FileAnalysis>();
  private errors = new Map<string, Error>();

  setResult(fileName: string, result: FileAnalysis) {
    this.results.set(fileName, result);
  }

  setError(fileName: string, error: Error) {
    this.errors.set(fileName, error);
  }

  async analyze(
    file: File,
    onProgress: (progress: number) => void,
  ): Promise<FileAnalysis> {
    // Simulate progress
    onProgress(0.5);
    onProgress(1.0);

    if (this.errors.has(file.name)) {
      throw new Error(ensureExists(this.errors.get(file.name)?.message));
    }
    const result = this.results.get(file.name);
    if (result) {
      return result;
    }
    throw new Error(`No mock result set for ${file.name}`);
  }

  async analyzeMergedAlignment(
    _files: ReadonlyArray<File>,
  ): Promise<AlignmentVerdict> {
    return {ok: true, droppedEvents: 0};
  }
}

// Helper to create a File object for tests
function createMockFile(name: string): File {
  return new File([], name);
}

describe('MultiTraceController', () => {
  let controller: MultiTraceController;
  let fakeAnalyzer: FakeTraceAnalyzer;
  let onStateChanged: Mock;
  let onAnalysisStarted: Mock;
  let onAnalysisCompleted: Mock;

  beforeEach(() => {
    fakeAnalyzer = new FakeTraceAnalyzer();
    onStateChanged = vi.fn();
    onAnalysisStarted = vi.fn();
    onAnalysisCompleted = vi.fn();
    controller = new MultiTraceController(
      fakeAnalyzer,
      onStateChanged,
      onAnalysisStarted,
      onAnalysisCompleted,
    );
  });

  it('should initialize with no traces', () => {
    expect(controller.traces).toHaveLength(0);
    expect(controller.isOpeningAllowed).toBe(false);
  });

  describe('addFiles', () => {
    it('should add files and trigger analysis', async () => {
      const file1 = createMockFile('trace1.pftrace');
      const file2 = createMockFile('trace2.pftrace');
      fakeAnalyzer.setResult(file1.name, {format: 'Perfetto'});
      fakeAnalyzer.setResult(file2.name, {format: 'Perfetto'});

      controller.addFiles([file1, file2]);

      expect(controller.traces).toHaveLength(2);
      // Analysis starts immediately, so status should be 'analyzing'
      expect(controller.traces[0]!.status).toBe('analyzing');
      expect(controller.traces[1]!.status).toBe('analyzing');
      expect(onStateChanged).toHaveBeenCalled();

      // Wait for analysis to complete
      await new Promise<void>((resolve) => {
        let completedCount = 0;
        onAnalysisCompleted.mockImplementation(() => {
          completedCount++;
          if (completedCount === 2) resolve();
        });
      });

      // Now traces should be analyzed
      expect(controller.traces[0]!.status).toBe('analyzed');
      expect(controller.traces[1]!.status).toBe('analyzed');
    });

    it('should handle format error messages', async () => {
      const file = createMockFile('bad_format.pftrace');
      fakeAnalyzer.setError(
        file.name,
        new Error('Something (ERR:fmt) happened'),
      );

      controller.addFiles([file]);

      // Wait for the async analysis to complete
      await new Promise<void>((resolve) => {
        onAnalysisCompleted.mockImplementation(() => resolve());
      });

      const trace = controller.traces[0]!;
      expect(trace.status).toBe('error');
      if (trace.status === 'error') {
        expect(trace.error).toContain("doesn't look like a Perfetto trace");
      }
    });
  });

  describe('removeTrace', () => {
    it('should remove a trace by UUID', () => {
      const trace1 = createMockAnalyzedTrace('uuid1');
      const trace2 = createMockAnalyzedTrace('uuid2');
      controller.setTracesForTesting([trace1, trace2]);

      controller.removeTrace('uuid1');

      expect(controller.traces).toHaveLength(1);
      expect(controller.traces[0]!.uuid).toBe('uuid2');
      expect(onStateChanged).toHaveBeenCalled();
    });

    it('should handle removing non-existent trace', () => {
      const trace = createMockAnalyzedTrace('uuid1');
      controller.setTracesForTesting([trace]);

      controller.removeTrace('non-existent-uuid');

      expect(controller.traces).toHaveLength(1);
    });
  });

  describe('isAnalyzing', () => {
    it('should return true when traces are being analyzed', () => {
      const trace1 = createMockAnalyzedTrace('uuid1');
      const trace2 = createMockAnalyzingTrace('uuid2', 0.5);
      controller.setTracesForTesting([trace1, trace2]);

      expect(controller.isAnalyzing()).toBe(true);
    });

    it('should return false when no traces are analyzing', () => {
      const trace1 = createMockAnalyzedTrace('uuid1');
      const trace2 = createMockAnalyzedTrace('uuid2');
      controller.setTracesForTesting([trace1, trace2]);

      expect(controller.isAnalyzing()).toBe(false);
    });

    it('should return false with no traces', () => {
      expect(controller.isAnalyzing()).toBe(false);
    });
  });

  describe('getLoadingError', () => {
    it('returns NO_TRACES when no traces are loaded', () => {
      expect(controller.getLoadingError()).toBe('NO_TRACES');
    });

    it('returns ANALYZING when traces are being analyzed', () => {
      const trace1 = createMockAnalyzedTrace('uuid1');
      const trace2 = createMockAnalyzingTrace('uuid2');
      controller.setTracesForTesting([trace1, trace2]);

      expect(controller.getLoadingError()).toBe('ANALYZING');
    });

    it('returns TRACE_ERROR when a trace has an error', () => {
      const trace1 = createMockAnalyzedTrace('uuid1');
      const trace2 = createMockErrorTrace('uuid2', 'Analysis failed');
      controller.setTracesForTesting([trace1, trace2]);

      expect(controller.getLoadingError()).toBe('TRACE_ERROR');
    });

    it('returns undefined when all traces are successfully analyzed', () => {
      const trace1 = createMockAnalyzedTrace('uuid1');
      const trace2 = createMockAnalyzedTrace('uuid2');
      controller.setTracesForTesting([trace1, trace2]);

      expect(controller.getLoadingError()).toBeUndefined();
      expect(controller.isOpeningAllowed).toBe(true);
    });
  });

  describe('async analysis behavior', () => {
    it('should complete analysis and update trace status', async () => {
      const file = createMockFile('trace.pftrace');
      fakeAnalyzer.setResult(file.name, {format: 'Perfetto'});

      controller.addFiles([file]);
      // Analysis starts immediately, so status should be 'analyzing'
      expect(controller.traces[0]!.status).toBe('analyzing');

      // Wait for async analysis to complete
      await new Promise<void>((resolve) => {
        onAnalysisCompleted.mockImplementation(() => resolve());
      });

      expect(controller.traces[0]!.status).toBe('analyzed');
      if (controller.traces[0]!.status === 'analyzed') {
        expect(controller.traces[0]!.analysis.format).toBe('Perfetto');
      }
    });

    it('should handle analysis errors', async () => {
      const file = createMockFile('error.pftrace');
      fakeAnalyzer.setError(file.name, new Error('Test analysis error'));

      controller.addFiles([file]);
      // Analysis starts immediately, so status should be 'analyzing'
      expect(controller.traces[0]!.status).toBe('analyzing');

      // Wait for async analysis to complete
      await new Promise<void>((resolve) => {
        onAnalysisCompleted.mockImplementation(() => resolve());
      });

      expect(controller.traces[0]!.status).toBe('error');
      if (controller.traces[0]!.status === 'error') {
        expect(controller.traces[0]!.error).toBe('Test analysis error');
      }
    });
  });

  describe('manifest serialization', () => {
    // A single-machine, single-clock (BOOTTIME) analyzed trace.
    function analyzed(uuid: string, name: string): TraceFileAnalyzed {
      return {
        uuid,
        file: new File([], name),
        status: 'analyzed',
        analysis: {
          format: 'Perfetto',
          singleClock: true,
          singleMachine: true,
          builtinClockIds: [6],
        },
      };
    }

    function manifest(): {files?: Array<Record<string, unknown>>} {
      return JSON.parse(controller.getManifestJson()).perfetto_manifest;
    }

    beforeEach(() => {
      controller.setTracesForTesting([
        analyzed('u1', 'a.pftrace'),
        analyzed('u2', 'b.pftrace'),
      ]);
    });

    it('is trivial until a file carries config', () => {
      expect(controller.hasManifestConfig()).toBe(false);
      expect(manifest().files).toBeUndefined();
    });

    it('manual mode emits nothing until an offset is set', () => {
      controller.updateConfig('u2', {alignMode: 'manual'});
      expect(controller.hasManifestConfig()).toBe(false);
    });

    it('serializes a manual offset against the baseline clock', () => {
      controller.updateConfig('u2', {alignMode: 'manual', offsetText: '500'});
      const entry = manifest().files?.find((f) => f.path === 'b.pftrace');
      // b's own BOOTTIME relates to a's BOOTTIME at +500ns.
      expect(entry?.clocks).toEqual({
        clock: 'BOOTTIME',
        sync_to: {file: 'a.pftrace', clock: 'BOOTTIME'},
        offset_ns: 500,
      });
    });

    describe('a clockless file against a multi-clock baseline', () => {
      // What the analyzer reports for a Perfetto trace with clock snapshots
      // and for a Tracy capture (or any clockless trace, e.g. JSON).
      function multiClock(uuid: string, name: string): TraceFileAnalyzed {
        return {
          uuid,
          file: new File([], name),
          status: 'analyzed',
          analysis: {
            format: 'Perfetto',
            singleClock: false,
            singleMachine: true,
            builtinClockIds: [1, 3, 6],
          },
        };
      }
      function clockless(uuid: string, name: string): TraceFileAnalyzed {
        return {
          uuid,
          file: new File([], name),
          status: 'analyzed',
          analysis: {
            format: 'Tracy',
            singleClock: true,
            privateClockOnly: true,
            singleMachine: true,
            builtinClockIds: [],
          },
        };
      }

      beforeEach(() => {
        controller.setTracesForTesting([
          multiClock('u1', 'a.pftrace'),
          clockless('u2', 'b.tracy'),
        ]);
        controller.updateConfig('u2', {alignMode: 'manual', offsetText: '500'});
      });

      it('pins it to the clock the baseline events are on', () => {
        const entry = manifest().files?.find((f) => f.path === 'b.tracy');
        // No source clock (the file is pinned), and a named reference clock:
        // without one the offset would relate to a's unused private clock.
        expect(entry?.clocks).toEqual({
          sync_to: {file: 'a.pftrace', clock: 'BOOTTIME'},
          offset_ns: 500,
        });
        // A pinned file has its own private clock so may share the machine.
        expect(controller.configError()).toBeUndefined();
      });

      it('offsets the first trace against the second', () => {
        // The first trace has nothing before it to be measured against; its
        // offset relates it to the next one rather than being dropped.
        controller.setTracesForTesting([
          clockless('u2', 'b.tracy'),
          multiClock('u1', 'a.pftrace'),
        ]);
        expect(controller.baselineName('u2')).toBe('a.pftrace');
        const entry = manifest().files?.find((f) => f.path === 'b.tracy');
        expect(entry?.clocks).toEqual({
          sync_to: {file: 'a.pftrace', clock: 'BOOTTIME'},
          offset_ns: 500,
        });
      });

      it('follows the chosen trace-time clock', () => {
        controller.setTraceTimeClock('MONOTONIC');
        const entry = manifest().files?.find((f) => f.path === 'b.tracy');
        expect(entry?.clocks).toEqual({
          sync_to: {file: 'a.pftrace', clock: 'MONOTONIC'},
          offset_ns: 500,
        });
      });
    });

    describe('a file the importer places as a whole', () => {
      function tracy(uuid: string, name: string): TraceFileAnalyzed {
        return {
          uuid,
          file: new File([], name),
          status: 'analyzed',
          analysis: {
            format: 'Tracy',
            singleClock: true,
            privateClockOnly: true,
            singleMachine: true,
            builtinClockIds: [],
            wholeFileAlignment: true,
          },
        };
      }

      beforeEach(() => {
        controller.setTracesForTesting([
          analyzed('u1', 'a.pftrace'),
          tracy('u2', 'b.tracy'),
        ]);
      });

      it('leaves the default to the importer', () => {
        // 'auto' is the importer's default (real clocks if the traces overlap
        // in time, else overlaid at the start): nothing to spell out.
        expect(controller.supportsWholeFileAlignment('u2')).toBe(true);
        expect(controller.supportsWholeFileAlignment('u1')).toBe(false);
        expect(controller.hasManifestConfig()).toBe(false);
      });

      it('serializes the explicit modes as align', () => {
        controller.updateConfig('u2', {alignMode: 'start'});
        let entry = manifest().files?.find((f) => f.path === 'b.tracy');
        expect(entry).toEqual({path: 'b.tracy', align: 'start'});

        controller.updateConfig('u2', {alignMode: 'clock'});
        entry = manifest().files?.find((f) => f.path === 'b.tracy');
        expect(entry).toEqual({path: 'b.tracy', align: 'clock'});
      });

      it('never emits align for a file which cannot take it', () => {
        // The importer rejects align on streamed formats.
        controller.updateConfig('u1', {alignMode: 'start'});
        expect(controller.hasManifestConfig()).toBe(false);
      });

      it('a fixed offset replaces align', () => {
        controller.updateConfig('u2', {alignMode: 'manual', offsetText: '7'});
        const entry = manifest().files?.find((f) => f.path === 'b.tracy');
        expect(entry?.align).toBeUndefined();
        expect(entry?.clocks).toEqual({
          sync_to: {file: 'a.pftrace', clock: 'BOOTTIME'},
          offset_ns: 7,
        });
      });
    });

    it('ignores a non-integer offset (free-text not yet valid)', () => {
      controller.updateConfig('u2', {alignMode: 'manual', offsetText: '-'});
      expect(controller.hasManifestConfig()).toBe(false);
    });

    it('flags an offset that shares a machine with the baseline', () => {
      controller.updateConfig('u2', {alignMode: 'manual', offsetText: '500'});
      // Both on the default machine: relating BOOTTIME to itself is rejected.
      expect(controller.configError()).toContain('its own machine');

      // Put u2 on its own machine: the offset is now valid.
      const id = controller.addMachine();
      controller.renameMachine(id, 'phone');
      controller.updateConfig('u2', {machineId: id});
      expect(controller.configError()).toBeUndefined();
    });

    it('assigns a file to a named machine', () => {
      const id = controller.addMachine();
      controller.renameMachine(id, 'phone');
      controller.updateConfig('u2', {machineId: id});
      const entry = manifest().files?.find((f) => f.path === 'b.pftrace');
      expect(entry?.machine).toEqual({name: 'phone'});
    });

    it('emits machines[] only once every embedded id is named', () => {
      controller.updateConfig('u1', {
        machines: [
          {id: 0, name: ''},
          {id: 1, name: 'server'},
        ],
      });
      // One id still blank: the importer rejects a partial remap, so emit none.
      expect(controller.hasManifestConfig()).toBe(false);

      controller.updateConfig('u1', {
        machines: [
          {id: 0, name: 'host'},
          {id: 1, name: 'server'},
        ],
      });
      const entry = manifest().files?.find((f) => f.path === 'a.pftrace');
      expect(entry?.machines).toEqual([
        {id: 0, name: 'host'},
        {id: 1, name: 'server'},
      ]);
    });
  });
});
