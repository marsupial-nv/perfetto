// Copyright (C) 2023 The Android Open Source Project
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

import type {
  ClockName,
  FileAnalysis,
  FileMergeConfig,
  TraceFile,
  TraceFileAnalyzed,
  TraceTimeConfig,
} from './multi_trace_types';
import {
  BUILTIN_CLOCKS,
  clockNamesForIds,
  defaultFileMergeConfig,
  parseOffsetNs,
} from './multi_trace_types';
import {uuidv4} from '../../base/uuid';
import {getErrorMessage as toErrorMessage} from '../../base/errors';
import type {AlignmentVerdict, TraceAnalyzer} from './trace_analyzer';
import type {MergeFile} from './merge_manifest';
import {
  buildManifestFile,
  isTrivialManifest,
  manifestToJson,
} from './merge_manifest';

function getErrorMessage(e: unknown): string {
  const err = toErrorMessage(e);
  if (err.includes('(ERR:fmt)')) {
    return `The file opened doesn't look like a Perfetto trace or any other supported trace format.`;
  }
  return err;
}

// A trace's single real (builtin) clock, if it has exactly one; undefined for a
// clockless trace or one exposing several clocks. Used as the default reference
// clock when a manual offset targets this trace.
function soleRealClock(trace: TraceFile): ClockName | undefined {
  if (trace.status !== 'analyzed') return undefined;
  const ids = trace.analysis.builtinClockIds ?? [];
  if (ids.length !== 1) return undefined;
  return BUILTIN_CLOCKS.find((c) => c.id === ids[0])?.name;
}

// The clock of |trace| a manual offset from another trace should refer to:
// its sole real clock or, if it exposes several (a Perfetto trace with clock
// snapshots), the one its events are on in the merged trace: the chosen
// trace-time clock if the trace has it, else the first present of BOOTTIME
// (what Perfetto traces default to), MONOTONIC, REALTIME. Undefined for a
// clockless trace, whose private clock is the reference.
//
// Leaving the clock out for a multi-clock reference would relate the offset
// file to the reference's private clock, which none of its events are on: the
// offset would have no effect.
function referenceClock(
  trace: TraceFile,
  traceTimeClock: ClockName | undefined,
): ClockName | undefined {
  const sole = soleRealClock(trace);
  if (sole !== undefined || trace.status !== 'analyzed') return sole;
  const names = clockNamesForIds(trace.analysis.builtinClockIds ?? []);
  if (traceTimeClock !== undefined && names.includes(traceTimeClock)) {
    return traceTimeClock;
  }
  const preference: ReadonlyArray<ClockName> = [
    'BOOTTIME',
    'MONOTONIC',
    'REALTIME',
  ];
  return preference.find((c) => names.includes(c));
}

// A user-defined machine in the shared registry.
export interface MachineEntry {
  readonly id: number;
  readonly name: string;
}

// The possible error states for the modal, used to show a helpful message
// to the user and disable the "Open Traces" button.
export type LoadingError =
  'NO_TRACES' | 'DUPLICATE_NAMES' | 'ANALYZING' | 'TRACE_ERROR';

// Minimum spacing between auto-run alignment dry-runs. The first change after a
// quiet period checks immediately (leading edge); rapid follow-ups coalesce
// into one trailing check this long after the last change.
const CHECK_DEBOUNCE_MS = 1500;

/**
 * The controller for the multi-trace modal.
 * This class manages the state of the traces and their analysis.
 */
export class MultiTraceController {
  private _traces: TraceFile[] = [];
  // Per-file merge configuration, keyed by trace uuid. Absent => default.
  private _configByUuid = new Map<string, FileMergeConfig>();
  // Shared, user-defined machines a single-machine file can be assigned to.
  // Files reference these by id (config.machineId); the name is resolved here
  // so renaming a machine propagates to every file using it.
  private _machines: ReadonlyArray<MachineEntry> = [];
  private _nextMachineId = 1;
  private _traceTime: TraceTimeConfig = {};
  // User-chosen baseline trace for all-private sets; undefined => first file.
  private _anchorUuid?: string;
  // The last whole-set alignment verdict; cleared whenever the config changes.
  private _verdict?: AlignmentVerdict;
  private _checking = false;
  // Bumped on every config change; lets checkAlignment drop a stale result.
  private _generation = 0;
  // Pending debounced auto-check; cancelled and rescheduled on each change.
  private _checkTimer?: ReturnType<typeof setTimeout>;
  // When the last auto-check started, to space out leading-edge checks.
  private _lastCheckStart = 0;
  private traceAnalyzer: TraceAnalyzer;
  private onStateChanged: () => void;
  private onAnalysisStarted?: (traceUuid: string) => void;
  private onAnalysisCompleted?: (traceUuid: string) => void;

  constructor(
    traceAnalyzer: TraceAnalyzer,
    onStateChanged: () => void,
    onAnalysisStarted?: (traceUuid: string) => void,
    onAnalysisCompleted?: (traceUuid: string) => void,
  ) {
    this.traceAnalyzer = traceAnalyzer;
    this.onStateChanged = onStateChanged;
    this.onAnalysisStarted = onAnalysisStarted;
    this.onAnalysisCompleted = onAnalysisCompleted;
  }

  // Test-only method to set traces directly
  setTracesForTesting(traces: TraceFile[]) {
    this._traces = [...traces];
  }

  get traces(): ReadonlyArray<TraceFile> {
    return this._traces;
  }

  get isOpeningAllowed(): boolean {
    return this.getLoadingError() === undefined;
  }

  getLoadingError(): LoadingError | undefined {
    if (this.traces.length === 0) {
      return 'NO_TRACES';
    }
    // Manifest and tar both key on file.name; duplicates would collide.
    if (this.hasDuplicateNames()) {
      return 'DUPLICATE_NAMES';
    }
    if (this.isAnalyzing()) {
      return 'ANALYZING';
    }
    if (this.hasErrors()) {
      return 'TRACE_ERROR';
    }
    return undefined;
  }

  private hasDuplicateNames(): boolean {
    const names = this._traces.map((t) => t.file.name);
    return new Set(names).size !== names.length;
  }

  addFiles(files: ReadonlyArray<File>) {
    for (const file of files) {
      const trace: TraceFile = {
        uuid: uuidv4(),
        file: file,
        status: 'not-analyzed',
      };
      this._traces.push(trace);
      this.analyzeTrace(trace);
    }
    this.invalidate();
  }

  removeTrace(uuid: string) {
    const index = this._traces.findIndex((t) => t.uuid === uuid);
    if (index !== -1) {
      this._traces.splice(index, 1);
      this._configByUuid.delete(uuid);
      this.invalidate();
    }
  }

  get traceTime(): Readonly<TraceTimeConfig> {
    return this._traceTime;
  }

  setTraceTimeClock(clock: ClockName | undefined) {
    this._traceTime = {...this._traceTime, clock};
    this.invalidate();
  }

  getConfig(uuid: string): FileMergeConfig {
    return this._configByUuid.get(uuid) ?? defaultFileMergeConfig();
  }

  updateConfig(uuid: string, patch: Partial<FileMergeConfig>) {
    const next = {...this.getConfig(uuid), ...patch};
    this._configByUuid.set(uuid, next);
    this.invalidate();
  }

  // The shared machine registry single-machine files pick from.
  get machines(): ReadonlyArray<MachineEntry> {
    return this._machines;
  }

  // Creates a machine (default-named so it never shows as blank) and returns
  // its id for the caller to assign to a file.
  addMachine(): number {
    const id = this._nextMachineId++;
    this._machines = [...this._machines, {id, name: `Machine ${id}`}];
    this.invalidate();
    return id;
  }

  renameMachine(id: number, name: string) {
    this._machines = this._machines.map((mm) =>
      mm.id === id ? {id, name} : mm,
    );
    this.invalidate();
  }

  // The resolved (trimmed, non-empty) machine name a file is assigned to, or
  // undefined for the host machine / an unnamed registry entry.
  machineNameForTrace(uuid: string): string | undefined {
    const {machineId} = this.getConfig(uuid);
    if (machineId === undefined) {
      return undefined;
    }
    const name = this._machines.find((mm) => mm.id === machineId)?.name.trim();
    return name !== undefined && name.length > 0 ? name : undefined;
  }

  // The baseline trace a manual offset is measured against: the first ordered
  // trace (the trace-time master). Its name labels the offset control.
  baselineName(uuid: string): string | undefined {
    return this.baselineFor(uuid)?.file.name;
  }

  // The trace a manual offset of |uuid| is measured against: the first ordered
  // trace, or the second if |uuid| is itself the first. (An offset relates two
  // traces, so the first one can carry it just as well; without this its
  // control would do nothing.)
  private baselineFor(uuid: string): TraceFile | undefined {
    return this.orderedTraces().find((t) => t.uuid !== uuid);
  }

  // Whether the importer places |uuid| on the timeline as a whole, in which
  // case it takes the `clock` and `start` modes and a smarter `auto`.
  supportsWholeFileAlignment(uuid: string): boolean {
    const trace = this._traces.find((t) => t.uuid === uuid);
    return (
      trace?.status === 'analyzed' && trace.analysis.wholeFileAlignment === true
    );
  }

  // The {file, clock} a manual offset syncs to: the baseline's path and its
  // reference clock (omitted when the baseline is clockless, so the importer
  // resolves it). Undefined when there is no other trace.
  private baselineReference(
    uuid: string,
  ): {file: string; clock?: ClockName} | undefined {
    const baseline = this.baselineFor(uuid);
    if (baseline === undefined) {
      return undefined;
    }
    return {
      file: baseline.file.name,
      clock: referenceClock(baseline, this._traceTime.clock),
    };
  }

  // A message for the status line when the config has an entry the user must fix
  // before opening. Undefined when every entry is well-formed. Covers a manual
  // offset that isn't a whole number, and an offset between two traces that
  // share a machine (an offset relates two distinct clocks, so the offset file
  // must be on its own machine, else the importer rejects the self-relation).
  configError(): string | undefined {
    for (const trace of this._traces) {
      const config = this.getConfig(trace.uuid);
      const text = config.offsetText?.trim() ?? '';
      if (
        config.alignMode === 'manual' &&
        text.length > 0 &&
        parseOffsetNs(text) === undefined
      ) {
        return `Enter a whole number of nanoseconds for ${trace.file.name}'s offset.`;
      }
    }
    for (const trace of this._traces) {
      const baseline = this.baselineFor(trace.uuid);
      if (baseline !== undefined) {
        const baselineMachine = this.machineNameForTrace(baseline.uuid);
        const config = this.getConfig(trace.uuid);
        if (
          config.alignMode === 'manual' &&
          parseOffsetNs(config.offsetText) !== undefined &&
          // A clockless file pins a distinct private clock, so it may share a
          // machine; a real-clock file would relate its clock to itself.
          soleRealClock(trace) !== undefined &&
          this.machineNameForTrace(trace.uuid) === baselineMachine
        ) {
          return (
            `${trace.file.name} has an offset but shares a machine with ` +
            `${baseline.file.name}. An offset relates two different clocks, ` +
            `so put ${trace.file.name} on its own machine.`
          );
        }
      }
    }
    return undefined;
  }

  private analyzedAnalyses(): FileAnalysis[] {
    return this._traces
      .filter((t): t is TraceFileAnalyzed => t.status === 'analyzed')
      .map((t) => t.analysis);
  }

  private allAnalyzed(): boolean {
    return (
      this._traces.length > 0 &&
      this._traces.every((t) => t.status === 'analyzed')
    );
  }

  private allPrivateClock(): boolean {
    return this.analyzedAnalyses().every((a) => a.privateClockOnly === true);
  }

  // Run after any trace-set or config change. The clock is reconciled only once
  // analysis settles, else adding a file would transiently wipe the choice.
  private invalidate() {
    this._generation++;
    this._verdict = undefined;
    if (
      this.allAnalyzed() &&
      this._traceTime.clock !== undefined &&
      !this.availableTraceTimeOptions().includes(this._traceTime.clock)
    ) {
      this._traceTime = {...this._traceTime, clock: undefined};
    }
    if (
      this._anchorUuid !== undefined &&
      !this._traces.some((t) => t.uuid === this._anchorUuid)
    ) {
      this._anchorUuid = undefined;
    }
    this.scheduleCheck();
    this.onStateChanged();
  }

  // Keep the alignment status current without a manual button. The first change
  // after a quiet period checks immediately; bursts coalesce into one trailing
  // check. Only runs once the set is openable.
  private scheduleCheck() {
    if (this._checkTimer !== undefined) {
      clearTimeout(this._checkTimer);
      this._checkTimer = undefined;
    }
    if (
      this.getLoadingError() !== undefined ||
      this.configError() !== undefined
    ) {
      return;
    }
    const sinceLast = Date.now() - this._lastCheckStart;
    if (!this._checking && sinceLast >= CHECK_DEBOUNCE_MS) {
      this.runCheck();
      return;
    }
    const wait = this._checking
      ? CHECK_DEBOUNCE_MS
      : CHECK_DEBOUNCE_MS - sinceLast;
    this._checkTimer = setTimeout(
      () => {
        this._checkTimer = undefined;
        this.runCheck();
      },
      Math.max(0, wait),
    );
  }

  private runCheck() {
    this._lastCheckStart = Date.now();
    void this.checkAlignment();
  }

  // Empty unless there are >=2 real clocks to choose between; with one (or
  // none) everything aligns to that single domain and the choice is moot.
  availableTraceTimeOptions(): ReadonlyArray<ClockName> {
    if (this._traces.length < 2 || !this.allAnalyzed()) {
      return [];
    }
    const ids = new Set<number>();
    for (const a of this.analyzedAnalyses()) {
      for (const id of a.builtinClockIds ?? []) {
        ids.add(id);
      }
    }
    const present = BUILTIN_CLOCKS.filter((c) => ids.has(c.id)).map(
      (c) => c.name,
    );
    return present.length >= 2 ? present : [];
  }

  // The baseline trace for an all-private set (user's choice, else the first);
  // undefined when a real clock anchors instead.
  referenceTraceUuid(): string | undefined {
    if (
      this._traces.length < 2 ||
      !this.allAnalyzed() ||
      !this.allPrivateClock()
    ) {
      return undefined;
    }
    if (
      this._anchorUuid !== undefined &&
      this._traces.some((t) => t.uuid === this._anchorUuid)
    ) {
      return this._anchorUuid;
    }
    return this._traces[0]?.uuid;
  }

  setAnchor(uuid: string) {
    this._anchorUuid = uuid;
    this.invalidate();
  }

  get alignmentVerdict(): AlignmentVerdict | undefined {
    return this._verdict;
  }

  get isCheckingAlignment(): boolean {
    return this._checking;
  }

  async checkAlignment() {
    if (this._traces.length === 0 || this._checking) {
      return;
    }
    this._checking = true;
    this._verdict = undefined;
    this.onStateChanged();
    const gen = this._generation;
    try {
      const verdict = await this.traceAnalyzer.analyzeMergedAlignment(
        this.getMergeFileList(),
      );
      if (gen === this._generation) {
        this._verdict = verdict;
      }
    } catch (e) {
      if (gen === this._generation) {
        this._verdict = {
          ok: false,
          droppedEvents: 0,
          validationError: getErrorMessage(e),
        };
      }
    } finally {
      this._checking = false;
      this.onStateChanged();
      // A change landed mid-run: its result was dropped, so check again for it.
      if (gen !== this._generation) {
        this.scheduleCheck();
      }
    }
  }

  // Baseline first: TraceProcessor makes the first trace the trace-time master.
  private orderedTraces(): TraceFile[] {
    const ref = this.referenceTraceUuid();
    const idx =
      ref === undefined ? -1 : this._traces.findIndex((t) => t.uuid === ref);
    if (idx <= 0) {
      return this._traces;
    }
    const copy = [...this._traces];
    const [anchor] = copy.splice(idx, 1);
    return [anchor!, ...copy];
  }

  private mergeFiles(): MergeFile[] {
    return this.orderedTraces().map((t) => {
      const config = this.getConfig(t.uuid);
      return {
        path: t.file.name,
        alignMode: config.alignMode,
        offsetNs: parseOffsetNs(config.offsetText),
        // Relate this file's own clock (if it has one) to the baseline; a
        // clockless file leaves it undefined so its private clock is pinned.
        sourceClock: soleRealClock(t),
        reference:
          config.alignMode === 'manual'
            ? this.baselineReference(t.uuid)
            : undefined,
        machineName: this.machineNameForTrace(t.uuid),
        machines: config.machines,
        wholeFileAlignment: this.supportsWholeFileAlignment(t.uuid),
      };
    });
  }

  hasManifestConfig(): boolean {
    return !isTrivialManifest(this.mergeFiles(), this._traceTime);
  }

  getManifestJson(): string {
    return manifestToJson(this.mergeFiles(), this._traceTime);
  }

  // Manifest first (when non-trivial), then the trace files (baseline leading).
  getMergeFileList(): ReadonlyArray<File> {
    const traceFiles = this.orderedTraces().map((t) => t.file);
    if (!this.hasManifestConfig()) {
      return traceFiles;
    }
    const manifest = buildManifestFile(this.mergeFiles(), this._traceTime);
    return [manifest, ...traceFiles];
  }

  isAnalyzing(): boolean {
    return this.traces.some((t) => t.status === 'analyzing');
  }

  private hasErrors(): boolean {
    return this.traces.some((t) => t.status === 'error');
  }

  private async analyzeTrace(trace: TraceFile) {
    const index = this._traces.findIndex((t) => t.uuid === trace.uuid);
    if (index === -1) return;

    try {
      this._traces[index] = {
        ...trace,
        status: 'analyzing',
        progress: 0,
      };
      this.onStateChanged();
      this.onAnalysisStarted?.(trace.uuid);

      const result = await this.traceAnalyzer.analyze(
        trace.file,
        (progress) => {
          if (this._traces[index]?.status === 'analyzing') {
            this._traces[index] = {
              ...this._traces[index],
              progress,
            };
            this.onStateChanged();
          }
        },
      );

      const analyzedTrace: TraceFileAnalyzed = {
        ...trace,
        status: 'analyzed',
        analysis: result,
      };
      this._traces[index] = analyzedTrace;
      // Autodetect gives the embedded ids, not names; seed blank names so the
      // remap table renders one row per machine.
      if (
        result.singleMachine === false &&
        result.embeddedMachineIds !== undefined
      ) {
        this._configByUuid.set(trace.uuid, {
          ...this.getConfig(trace.uuid),
          machines: result.embeddedMachineIds.map((id) => ({id, name: ''})),
        });
      }
      this.invalidate();
      this.onAnalysisCompleted?.(trace.uuid);
    } catch (e) {
      this._traces[index] = {
        ...trace,
        status: 'error',
        error: getErrorMessage(e),
      };
      this.invalidate();
      this.onAnalysisCompleted?.(trace.uuid);
    }
  }
}
