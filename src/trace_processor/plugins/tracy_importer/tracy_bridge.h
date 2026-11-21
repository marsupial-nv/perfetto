/*
 * Copyright (C) 2026 The Android Open Source Project
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

#ifndef SRC_TRACE_PROCESSOR_PLUGINS_TRACY_IMPORTER_TRACY_BRIDGE_H_
#define SRC_TRACE_PROCESSOR_PLUGINS_TRACY_IMPORTER_TRACY_BRIDGE_H_

#include <stddef.h>
#include <stdint.h>

// Narrow boundary between trace processor and the Tracy profiler's server
// library (https://github.com/wolfpld/tracy).
//
// The .tracy format has no specification: it is a versioned dump of Tracy's
// in-memory state, so it is read with Tracy's own tracy::Worker. Tracy's code
// needs C++20, exceptions and RTTI, none of which the rest of trace processor
// is built with. tracy_bridge.cc is therefore the only translation unit which
// includes Tracy headers and is compiled with its own flags; this header is
// deliberately free of Tracy types, STL types and exceptions so it can be
// included from both sides.

namespace perfetto::trace_processor::tracy_importer {

struct TracyCaptureInfo {
  const char* capture_name;     // Name of the capture, usually "prog @ date".
  const char* capture_program;  // Name of the profiled program.
  const char* host_info;        // Free-form multi-line host description.
  uint64_t pid;                 // Pid of the profiled program; 0 if unknown.
  uint64_t capture_time_s;      // Unix time (seconds) of the capture start.
  int64_t first_time_ns;        // Timestamp of the first event.
  int64_t last_time_ns;         // Timestamp of the last event.
  uint32_t file_version;        // (major << 16) | (minor << 8) | patch.
};

// The extent of the events of a capture, in Tracy timestamps.
struct TracyTimeRange {
  int64_t first_event_ns;  // Earliest event of any kind.
  int64_t last_event_ns;   // End of the capture.
  // Start of the earliest CPU zone; equal to first_event_ns if there is none.
  // The first event of a capture tends to be the synthetic first frame at the
  // very start of the capture, well before the program does anything.
  int64_t first_zone_ns;
};

struct TracyImportStats {
  double load_seconds;  // Time spent in Tracy reading the file.
  double emit_seconds;  // Time spent walking Tracy's data (incl. sink calls).
  uint64_t zones;
  uint64_t gpu_zones;
  uint64_t frames;
  uint64_t messages;
  uint64_t plot_points;
  // Events whose timestamp went backwards within their own (supposedly
  // ordered) stream; these are clamped to the previous timestamp.
  uint64_t out_of_order_events;
};

// Receiver of the contents of a Tracy capture. Implemented on the trace
// processor side. All `const char*` are valid only for the duration of the
// call. All timestamps are in nanoseconds on the capture's timeline.
//
// Calls happen in this order:
//  1. OnCaptureInfo().
//  2. All the On*Track() calls and OnPlot(): each returns an opaque handle the
//     bridge passes back when emitting events on that track.
//  3. OnTimeRange().
//  4. OnZone() / OnFrame() / OnMessage(), interleaved, globally ordered by
//     non-decreasing |ts|, with Intern*() calls interleaved as needed.
//  5. OnPlotPoint(), globally ordered by non-decreasing |ts|.
class TracySink {
 public:
  static constexpr uint32_t kNone = 0xffffffffu;

  virtual ~TracySink();

  virtual void OnCaptureInfo(const TracyCaptureInfo&) = 0;
  virtual void OnTimeRange(const TracyTimeRange&) = 0;

  // A thread (or fiber) holding CPU zones.
  virtual uint32_t OnThreadTrack(uint64_t tid,
                                 const char* name,
                                 bool is_fiber) = 0;
  // The track holding the messages logged by the thread |tid|.
  virtual uint32_t OnMessageTrack(uint64_t tid) = 0;
  // A frame set (e.g. the default "Frame" set).
  virtual uint32_t OnFrameTrack(const char* name) = 0;
  // GPU zones of the GPU context |context_index| submitted by thread |tid|.
  virtual uint32_t OnGpuTrack(uint32_t context_index,
                              const char* context_name,
                              const char* context_type,
                              uint64_t tid) = 0;
  virtual uint32_t OnPlot(const char* name, const char* type) = 0;

  // Interning. The bridge calls each of these at most once per distinct Tracy
  // source location / string and passes the returned handle to OnZone().
  virtual uint32_t InternSourceLocation(const char* zone_name,
                                        const char* function,
                                        const char* file,
                                        uint32_t line) = 0;
  virtual uint32_t InternString(const char* str) = 0;

  // A CPU or GPU zone. |dur| is -1 if the zone never ended. |depth| and
  // |parent| (the value returned by the OnZone() call for the enclosing zone,
  // or kNone) describe the nesting within |track|. |name| (a handle from
  // InternString()) overrides the name of the source location if != kNone.
  // |text| (ditto) is the user text attached to the zone, if any. Returns a
  // handle for the zone, used as |parent| of its children.
  virtual uint32_t OnZone(uint32_t track,
                          int64_t ts,
                          int64_t dur,
                          uint32_t srcloc,
                          uint32_t depth,
                          uint32_t parent,
                          uint32_t name,
                          uint32_t text) = 0;
  virtual void OnFrame(uint32_t track,
                       int64_t ts,
                       int64_t dur,
                       uint64_t frame_number) = 0;
  virtual void OnMessage(uint32_t track,
                         int64_t ts,
                         const char* text,
                         uint32_t color) = 0;
  virtual void OnPlotPoint(uint32_t plot, int64_t ts, double value) = 0;
};

// Loads the Tracy capture at |path| and replays its contents into |sink|.
// Returns true on success. On failure returns false and writes a
// null-terminated message into |err| (of size |err_size|).
bool ImportTracyFile(const char* path,
                     TracySink* sink,
                     TracyImportStats* stats,
                     char* err,
                     size_t err_size);

}  // namespace perfetto::trace_processor::tracy_importer

#endif  // SRC_TRACE_PROCESSOR_PLUGINS_TRACY_IMPORTER_TRACY_BRIDGE_H_
