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

#ifndef SRC_TRACE_PROCESSOR_PLUGINS_TRACY_IMPORTER_TRACY_TRACE_READER_H_
#define SRC_TRACE_PROCESSOR_PLUGINS_TRACY_IMPORTER_TRACY_TRACE_READER_H_

#include <cstddef>
#include <cstdint>
#include <optional>

#include "perfetto/base/status.h"
#include "perfetto/ext/base/temp_file.h"
#include "perfetto/trace_processor/trace_blob_view.h"
#include "src/trace_processor/importers/common/chunked_trace_reader.h"

namespace perfetto::trace_processor {
class TraceProcessorContext;
}

namespace perfetto::trace_processor::tracy_importer {

// Returns whether |data| starts with one of the magic numbers of the Tracy
// profiler's capture format (.tracy).
bool IsTracyCapture(const uint8_t* data, size_t size);

// State shared by the readers of all the Tracy captures of one load.
struct TracyLoadState {
  // Of the captures read so far, the one whose first event is the earliest:
  // the trace time of that event and of the start of its first zone.
  std::optional<int64_t> first_event_ts;
  int64_t first_zone_ts = 0;
};

// Reads captures saved by the Tracy profiler (.tracy files).
//
// Tracy's reader (tracy::FileRead) only works on a file it can mmap, while
// trace processor hands the trace over in chunks. So the chunks are spooled to
// a temporary file and the whole import happens once the last chunk has been
// seen: Tracy's own tracy::Worker loads the file (see tracy_bridge.h) and its
// contents are replayed in timestamp order (Tracy keeps every thread's zones
// ordered by time, so a k-way merge across threads is all that takes).
//
// Where the events go then depends on whether anything else is being loaded:
//  - if the capture is the only trace (the root file of the load) they are
//    written straight into the storage tables, bypassing the sorter;
//  - if it is inside an archive (possibly next to other traces, e.g. the
//    result of the UI's "Open multiple traces") they go through the
//    TraceSorter like the events of any other trace, as the tables must be
//    filled in timestamp order across all of them.
//
// Timestamps: Tracy's are nanoseconds since the start of the capture. They are
// rebased as a whole onto trace time; see ComputeTsOffset() in the .cc.
class TracyTraceReader : public ChunkedTraceReader {
 public:
  TracyTraceReader(TraceProcessorContext* context,
                   uint32_t file_id,
                   TracyLoadState* load_state);
  ~TracyTraceReader() override;

  base::Status Parse(TraceBlobView blob) override;
  base::Status OnPushDataToSorter() override;
  void OnEventsFullyExtracted() override {}

 private:
  TraceProcessorContext* const context_;
  // Whether this capture is the root file of the load rather than a member
  // of an archive.
  const bool is_only_trace_;
  TracyLoadState* const load_state_;
  std::optional<base::TempFile> spool_;
};

}  // namespace perfetto::trace_processor::tracy_importer

#endif  // SRC_TRACE_PROCESSOR_PLUGINS_TRACY_IMPORTER_TRACY_TRACE_READER_H_
