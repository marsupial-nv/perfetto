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

// Lets a page that embeds the UI drive the view: zoom to a time range, select
// a slice, pin tracks, show the rows of a query as a track, add notes. Used to
// follow what an analysis agent is looking at. See protocol.ts for the wire
// format and for who is allowed to send commands.

import {setThemeOverride} from '../../base/theme_override';
import {Time} from '../../base/time';
import {addDebugSliceTrack} from '../../components/tracks/debug_tracks';
import type {App} from '../../public/app';
import type {PerfettoPlugin} from '../../public/plugin';
import type {Trace} from '../../public/trace';
import {DrawerPanelVisibility} from '../../widgets/drawer_panel';
import {
  isAllowedOrigin,
  parseRequest,
  REMOTE_KEY,
  type RemoteCommand,
  type RemoteReply,
  type RemoteStatus,
} from './protocol';

const DEBUG_URI_PREFIX = 'debug.track';
const SELECT_SETTLE_MS = 250;

// What this plugin added to a trace, so that it can be replaced or removed.
class RemoteView {
  private pinnedUris: string[] = [];
  private debugUris = new Map<string, string[]>();
  private noteIds = new Set<string>();

  constructor(private readonly trace: Trace) {}

  status(): RemoteStatus {
    const span = this.trace.timeline.visibleWindow.toTimeSpan();
    const info = this.trace.traceInfo;
    return {
      state: 'ready',
      traceTitle: info.traceTitle,
      traceStart: info.start.toString(),
      traceEnd: info.end.toString(),
      visibleStart: span.start.toString(),
      visibleEnd: span.end.toString(),
    };
  }

  async apply(cmd: RemoteCommand): Promise<string | undefined> {
    const trace = this.trace;
    switch (cmd.op) {
      case 'zoom': {
        const info = trace.traceInfo;
        // Clamp to the trace: a range outside it is a mistake of the sender,
        // and panning there would show an empty timeline.
        let start = Time.fromRaw(cmd.start);
        let end = Time.fromRaw(cmd.end);
        if (end < info.start || start > info.end) return 'zoom: outside trace';
        if (start < info.start) start = info.start;
        if (end > info.end) end = info.end;
        if (end <= start) end = Time.fromRaw(start + 1n);
        // The sender chooses the range it wants on screen, margins included.
        trace.timeline.panSpanIntoView(start, end, {align: 'zoom', margin: 0});
        return undefined;
      }
      case 'select':
        trace.selection.selectSqlEvent(cmd.table, cmd.id, {
          scrollToSelection: cmd.scroll,
          switchToCurrentSelectionTab: false,
        });
        if (cmd.scroll) {
          // The selection is resolved asynchronously and then scrolls the
          // timeline to itself. Let that settle, so that a zoom that follows
          // in the same message is not cut short by it.
          await new Promise((resolve) => setTimeout(resolve, SELECT_SETTLE_MS));
        }
        return undefined;
      case 'pin_tracks': {
        if (cmd.replace) this.unpinAll();
        const missing: number[] = [];
        for (const id of cmd.trackIds) {
          const track = trace.tracks.findTrack((t) =>
            t.tags?.trackIds?.includes(id),
          );
          const node = track && trace.currentWorkspace.getTrackByUri(track.uri);
          if (!node) {
            missing.push(id);
            continue;
          }
          if (!node.isPinned) {
            node.pin();
            this.pinnedUris.push(node.uri!);
          }
        }
        return missing.length > 0
          ? `pin_tracks: no track for ${missing.join(', ')}`
          : undefined;
      }
      case 'debug_track': {
        this.removeDebugTracks(cmd.key);
        const before = new Set(this.debugTrackUris());
        // One colour for the whole track: colour by a constant column.
        const sqlSource = cmd.uniform
          ? `SELECT ts, dur, name, 'uniform' AS color FROM (${cmd.sql.replace(/;\s*$/, '')})`
          : cmd.sql;
        await addDebugSliceTrack({
          trace,
          data: {
            sqlSource,
            columns: cmd.uniform
              ? ['ts', 'dur', 'name', 'color']
              : ['ts', 'dur', 'name'],
          },
          title: cmd.title,
          columns: {ts: 'ts', dur: 'dur', name: 'name'},
          rawColumns: ['ts', 'dur', 'name'],
          colorColumn: cmd.uniform ? 'color' : undefined,
        });
        this.debugUris.set(
          cmd.key,
          this.debugTrackUris().filter((u) => !before.has(u)),
        );
        return undefined;
      }
      case 'note': {
        const args = {id: `remote_${cmd.id}`, text: cmd.text, color: cmd.color};
        if (cmd.end !== undefined && cmd.end > cmd.start) {
          trace.notes.addSpanNote({
            ...args,
            start: Time.fromRaw(cmd.start),
            end: Time.fromRaw(cmd.end),
          });
        } else {
          trace.notes.addNote({...args, timestamp: Time.fromRaw(cmd.start)});
        }
        this.noteIds.add(args.id);
        return undefined;
      }
      case 'select_area': {
        const uris: string[] = [];
        if (cmd.trackIds.length === 0) {
          for (const n of trace.currentWorkspace.pinnedTracks) {
            if (n.uri !== undefined) uris.push(n.uri);
          }
        } else {
          for (const id of cmd.trackIds) {
            const track = trace.tracks.findTrack((t) =>
              t.tags?.trackIds?.includes(id),
            );
            if (track) uris.push(track.uri);
          }
          // The track of query results stands for "what was matched".
          for (const added of this.debugUris.values()) uris.push(...added);
        }
        if (uris.length === 0) return 'select_area: no tracks';
        trace.selection.selectArea(
          {
            start: Time.fromRaw(cmd.start),
            end: Time.fromRaw(cmd.end),
            trackUris: uris,
          },
          {scrollToSelection: false, switchToCurrentSelectionTab: false},
        );
        return undefined;
      }
      case 'drawer':
        trace.tabs.setTabPanelVisibility(
          cmd.state === 'collapsed'
            ? DrawerPanelVisibility.COLLAPSED
            : DrawerPanelVisibility.VISIBLE,
        );
        return undefined;
      case 'deselect':
        trace.selection.clearSelection();
        return undefined;
      case 'theme':
        return undefined; // handled before a trace is needed
      case 'clear':
        this.unpinAll();
        for (const key of [...this.debugUris.keys()]) {
          this.removeDebugTracks(key);
        }
        for (const id of this.noteIds) trace.notes.removeNote(id);
        this.noteIds.clear();
        trace.selection.clearSelection();
        return undefined;
    }
  }

  private debugTrackUris(): string[] {
    return this.trace.currentWorkspace.pinnedTracks
      .map((n) => n.uri)
      .filter((u): u is string => u?.startsWith(DEBUG_URI_PREFIX) ?? false);
  }

  private unpinAll() {
    const pinned = this.trace.currentWorkspace.pinnedTracksNode;
    for (const uri of this.pinnedUris) {
      const node = pinned.children.find((n) => n.uri === uri);
      if (node) pinned.removeChild(node);
    }
    this.pinnedUris = [];
  }

  private removeDebugTracks(key: string) {
    const pinned = this.trace.currentWorkspace.pinnedTracksNode;
    for (const uri of this.debugUris.get(key) ?? []) {
      const node = pinned.children.find((n) => n.uri === uri);
      if (node) pinned.removeChild(node);
    }
    this.debugUris.delete(key);
  }
}

export default class RemoteControl implements PerfettoPlugin {
  static readonly id = 'dev.perfetto.RemoteControl';
  static readonly description =
    'Lets a page that embeds the UI in an iframe drive the view with ' +
    'postMessage: zoom, select, pin tracks, highlight query results.';

  private static view?: RemoteView;
  private static rpcUrl?: string;
  private static app?: App;
  // The embedder that last sent a valid message; trace_ready goes there.
  private static peer?: {window: Window; origin: string};
  // Commands are applied one request at a time, in arrival order.
  private static queue: Promise<void> = Promise.resolve();

  static onActivate(app: App): void {
    RemoteControl.app = app;
    RemoteControl.rpcUrl = app.initialRouteArgs.rpc_url;
    window.addEventListener('message', (e) => RemoteControl.onMessage(e));
  }

  async onTraceLoad(trace: Trace): Promise<void> {
    trace.onTraceReady.addListener(() => {
      RemoteControl.view = new RemoteView(trace);
      RemoteControl.send({type: 'status', ...RemoteControl.view.status()});
    });
    trace.trash.defer(() => {
      RemoteControl.view = undefined;
    });
  }

  private static send(reply: RemoteReply) {
    const peer = RemoteControl.peer;
    if (peer === undefined) return;
    peer.window.postMessage({[REMOTE_KEY]: reply}, peer.origin);
  }

  private static onMessage(e: MessageEvent) {
    const request = parseRequest(e.data);
    if (request === undefined) return;
    const source = e.source as Window | null;
    // Only a window that embeds or opened this one, never a frame inside it.
    if (source === null || source === window) return;
    if (source !== window.parent && source !== window.opener) return;
    if (
      !isAllowedOrigin(e.origin, window.location.origin, RemoteControl.rpcUrl)
    ) {
      console.warn(`RemoteControl: ignoring message from ${e.origin}`);
      return;
    }
    RemoteControl.peer = {window: source, origin: e.origin};
    RemoteControl.queue = RemoteControl.queue.then(async () => {
      const view = RemoteControl.view;
      const errors: Array<string | undefined> = [];
      for (const cmd of request.commands) {
        if (typeof cmd === 'string') {
          errors.push(cmd);
        } else if (cmd.op === 'theme') {
          // Works before a trace is loaded, so the first paint matches.
          setThemeOverride(cmd.theme);
          RemoteControl.app?.raf.scheduleFullRedraw();
          errors.push(undefined);
        } else if (view === undefined) {
          errors.push('no trace loaded');
        } else {
          try {
            errors.push(await view.apply(cmd));
          } catch (err) {
            errors.push(`${cmd.op}: ${err}`);
          }
        }
      }
      const status: RemoteStatus = RemoteControl.view?.status() ?? {
        state: 'no_trace',
      };
      RemoteControl.send({type: 'result', seq: request.seq, errors, ...status});
    });
  }
}
