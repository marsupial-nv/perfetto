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

#include "src/trace_processor/plugins/tracy_importer/tracy_importer.h"

#include <cstddef>
#include <cstdint>
#include <memory>

#include "perfetto/base/compiler.h"
#include "src/trace_processor/core/plugin/plugin.h"
#include "src/trace_processor/importers/common/chunked_trace_reader.h"
#include "src/trace_processor/plugins/tracy_importer/tracy_trace_reader.h"
#include "src/trace_processor/trace_reader_registry.h"
#include "src/trace_processor/types/trace_processor_context.h"
#include "src/trace_processor/util/trace_type.h"

namespace perfetto::trace_processor::tracy_importer {
namespace {

// The Tracy trace type: captures saved by the Tracy profiler (.tracy).
class TracyImporter : public TraceImporter<TracyImporter> {
 public:
  explicit TracyImporter(TracyLoadState* load_state)
      : TraceImporter(MakeDescriptor()), load_state_(load_state) {}

  SniffResult Sniff(const uint8_t* data, size_t size) const override {
    return {IsTracyCapture(data, size)};
  }

  base::StatusOr<std::unique_ptr<ChunkedTraceReader>> CreateReader(
      TraceProcessorContext* context,
      uint32_t file_id) const override {
    return std::unique_ptr<ChunkedTraceReader>(
        std::make_unique<TracyTraceReader>(context, file_id, load_state_));
  }

 private:
  TracyLoadState* const load_state_;

  static TraceTypeDescriptor MakeDescriptor() {
    TraceTypeDescriptor d;
    d.name = "tracy";
    // Like other formats without a clock of their own (e.g. JSON), a capture
    // lives on a private per-file clock; the reader decides what it reads.
    d.clock_policy = TraceClockPolicy::kTraceFile;
    // A capture's events only reach the sorter when it is loaded together
    // with other traces, in which case nothing may be extracted before all
    // of them have been read.
    d.sort_policy = TraceSortPolicy::kFullSort;
    // The reader places a capture on the timeline as a whole, possibly
    // relative to the traces loaded with it (see ComputeTsOffset() in
    // tracy_trace_reader.cc). For that it has to be read after all the traces
    // of other formats.
    d.supports_file_alignment = true;
    d.archive_priority = 4;
    // A 4 byte binary magic: unambiguous, so can be checked early.
    d.detection_priority = 5;
    return d;
  }
};

class TracyPlugin : public Plugin<TracyPlugin> {
 public:
  ~TracyPlugin() override;

  void RegisterImporters(TraceReaderRegistry& registry) override {
    registry.Register(std::make_unique<TracyImporter>(&load_state_));
  }

 private:
  // Outlives the importer and its readers: plugins are destroyed last.
  TracyLoadState load_state_;
};

TracyPlugin::~TracyPlugin() = default;

}  // namespace

void RegisterPlugin() {
  static PluginRegistration reg(
      []() -> std::unique_ptr<PluginBase> {
        return std::make_unique<TracyPlugin>();
      },
      TracyPlugin::kPluginId, TracyPlugin::kDepIds.data(),
      TracyPlugin::kDepIds.size());
  base::ignore_result(reg);
}

}  // namespace perfetto::trace_processor::tracy_importer
