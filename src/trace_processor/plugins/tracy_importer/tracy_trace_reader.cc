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

#include "src/trace_processor/plugins/tracy_importer/tracy_trace_reader.h"

#include <cstddef>
#include <cstdint>
#include <cstdlib>
#include <cstring>
#include <optional>
#include <string>
#include <utility>
#include <vector>

#include "perfetto/base/logging.h"
#include "perfetto/base/status.h"
#include "perfetto/ext/base/file_utils.h"
#include "perfetto/ext/base/flat_hash_map.h"
#include "perfetto/ext/base/status_macros.h"
#include "perfetto/ext/base/status_or.h"
#include "perfetto/ext/base/string_utils.h"
#include "perfetto/ext/base/string_view.h"
#include "perfetto/ext/base/temp_file.h"
#include "perfetto/trace_processor/trace_blob_view.h"
#include "protos/perfetto/common/builtin_clock.pbzero.h"
#include "src/trace_processor/importers/common/args_tracker.h"
#include "src/trace_processor/importers/common/clock_tracker.h"
#include "src/trace_processor/importers/common/process_tracker.h"
#include "src/trace_processor/importers/common/stats_tracker.h"
#include "src/trace_processor/importers/common/track_tracker.h"
#include "src/trace_processor/importers/common/tracks.h"
#include "src/trace_processor/importers/common/tracks_common.h"
#include "src/trace_processor/plugins/tracy_importer/tracy_bridge.h"
#include "src/trace_processor/sorter/trace_sorter.h"
#include "src/trace_processor/storage/stats.h"
#include "src/trace_processor/storage/trace_storage.h"
#include "src/trace_processor/tables/counter_tables_py.h"
#include "src/trace_processor/tables/slice_tables_py.h"
#include "src/trace_processor/types/trace_processor_context.h"
#include "src/trace_processor/types/variadic.h"

namespace perfetto::trace_processor::tracy_importer {
namespace {

// Tracy does not always know the pid of the profiled program. All threads
// still need to hang off one process, so make one up.
constexpr int64_t kFallbackPid = 1;

constexpr auto kMessagesBlueprint = tracks::SliceBlueprint(
    "tracy_messages",
    tracks::DimensionBlueprints(tracks::kThreadDimensionBlueprint),
    tracks::StaticNameBlueprint("Messages"));

constexpr auto kFramesBlueprint = tracks::SliceBlueprint(
    "tracy_frames",
    tracks::DimensionBlueprints(tracks::kProcessDimensionBlueprint,
                                tracks::StringDimensionBlueprint("frame_set")),
    tracks::DynamicNameBlueprint());

constexpr auto kGpuZonesBlueprint = tracks::SliceBlueprint(
    "tracy_gpu_zones",
    tracks::DimensionBlueprints(tracks::kProcessDimensionBlueprint,
                                tracks::UintDimensionBlueprint("gpu_context"),
                                tracks::LongDimensionBlueprint("tid")),
    tracks::DynamicNameBlueprint());

constexpr auto kPlotBlueprint = tracks::CounterBlueprint(
    "tracy_plot",
    tracks::UnknownUnitBlueprint(),
    tracks::DimensionBlueprints(tracks::kProcessDimensionBlueprint,
                                tracks::kNameFromTraceDimensionBlueprint),
    tracks::DynamicNameBlueprint());

// Writes the contents of a Tracy capture into the storage tables.
//
// Slices and counters are inserted directly in the tables rather than through
// SliceTracker / the sorter: the bridge already delivers them ordered by
// timestamp with their nesting resolved, so there is nothing left to work out.
class StorageSink : public TracySink {
 public:
  StorageSink(TraceProcessorContext* context, TracyLoadState* load_state)
      : context_(context),
        load_state_(load_state),
        storage_(context->storage.get()),
        slices_(context->storage->mutable_slice_table()),
        counters_(context->storage->mutable_counter_table()),
        function_key_(storage_->InternString("tracy.function")),
        file_key_(storage_->InternString("tracy.file")),
        line_key_(storage_->InternString("tracy.line")),
        text_key_(storage_->InternString("tracy.text")),
        frame_key_(storage_->InternString("tracy.frame")),
        color_key_(storage_->InternString("tracy.color")) {}
  ~StorageSink() override;

  void OnCaptureInfo(const TracyCaptureInfo& info) override {
    pid_ = info.pid == 0 ? kFallbackPid : static_cast<int64_t>(info.pid);
    capture_time_s_ = info.capture_time_s;
    upid_ =
        context_->process_tracker->GetOrCreateProcessWithoutMainThread(pid_);
    context_->process_tracker->UpdateProcessName(
        upid_, storage_->InternString(info.capture_program),
        ProcessNamePriority::kOther);
  }

  void OnTimeRange(const TracyTimeRange& range) override {
    if (std::optional<int64_t> offset = ComputeTsOffset(range)) {
      ts_offset_ = *offset;
      const int64_t first_event_ts = range.first_event_ns + ts_offset_;
      if (!load_state_->first_event_ts ||
          first_event_ts < *load_state_->first_event_ts) {
        load_state_->first_event_ts = first_event_ts;
        load_state_->first_zone_ts = range.first_zone_ns + ts_offset_;
      }
    } else {
      // The clock tracker has recorded why; like every other importer, drop
      // the events which cannot be placed on the timeline.
      drop_events_ = true;
    }
  }

  uint32_t OnThreadTrack(uint64_t tid, const char* name, bool) override {
    UniqueTid utid = GetOrCreateThread(tid);
    context_->process_tracker->UpdateThreadName(
        utid, storage_->InternString(name), ThreadNamePriority::kOther);
    thread_names_[tid] = name;
    return context_->track_tracker->InternThreadTrack(utid).value;
  }

  uint32_t OnMessageTrack(uint64_t tid) override {
    return context_->track_tracker
        ->InternTrack(kMessagesBlueprint,
                      tracks::Dimensions(GetOrCreateThread(tid)))
        .value;
  }

  uint32_t OnFrameTrack(const char* name) override {
    StringId name_id = storage_->InternString(name);
    TrackId track = context_->track_tracker->InternTrack(
        kFramesBlueprint, tracks::Dimensions(upid_, base::StringView(name)),
        tracks::DynamicName(name_id));
    frame_names_[track.value] = name_id;
    return track.value;
  }

  uint32_t OnGpuTrack(uint32_t context_index,
                      const char* context_name,
                      const char* context_type,
                      uint64_t tid) override {
    std::string name = "GPU ";
    name += context_type;
    name += " context " + std::to_string(context_index);
    if (context_name[0] != '\0')
      name += std::string(" (") + context_name + ")";
    if (std::string* thread_name = thread_names_.Find(tid))
      name += " [" + *thread_name + "]";
    return context_->track_tracker
        ->InternTrack(
            kGpuZonesBlueprint,
            tracks::Dimensions(upid_, context_index, static_cast<int64_t>(tid)),
            tracks::DynamicName(storage_->InternString(base::StringView(name))))
        .value;
  }

  uint32_t OnPlot(const char* name, const char*) override {
    return context_->track_tracker
        ->InternTrack(kPlotBlueprint,
                      tracks::Dimensions(upid_, base::StringView(name)),
                      tracks::DynamicName(storage_->InternString(name)))
        .value;
  }

  uint32_t InternSourceLocation(const char* zone_name,
                                const char* function,
                                const char* file,
                                uint32_t line) override {
    SourceLocation loc;
    loc.name = storage_->InternString(zone_name);
    loc.function = storage_->InternString(function);
    loc.file = storage_->InternString(file);
    loc.line = line;
    loc.arg_set_id = AddArgSet(loc, kNullStringId);
    source_locations_.push_back(loc);
    return static_cast<uint32_t>(source_locations_.size() - 1);
  }

  uint32_t InternString(const char* str) override {
    return storage_->InternString(str).raw_id();
  }

  uint32_t OnZone(uint32_t track,
                  int64_t ts,
                  int64_t dur,
                  uint32_t srcloc,
                  uint32_t depth,
                  uint32_t parent,
                  uint32_t name,
                  uint32_t text) override {
    if (PERFETTO_UNLIKELY(drop_events_))
      return kNone;
    return InsertZone(track, ts + ts_offset_, dur, srcloc, depth, parent, name,
                      text);
  }

  void OnFrame(uint32_t track,
               int64_t ts,
               int64_t dur,
               uint64_t frame_number) override {
    if (!drop_events_)
      InsertFrame(track, ts + ts_offset_, dur, frame_number);
  }

  void OnMessage(uint32_t track,
                 int64_t ts,
                 const char* text,
                 uint32_t color) override {
    if (!drop_events_) {
      InsertMessage(track, ts + ts_offset_, storage_->InternString(text),
                    color);
    }
  }

  void OnPlotPoint(uint32_t plot, int64_t ts, double value) override {
    if (!drop_events_)
      InsertPlotPoint(plot, ts + ts_offset_, value);
  }

  // The Insert*() methods take timestamps in trace time and, for each table,
  // must be called in order of non-decreasing timestamp.

  uint32_t InsertZone(uint32_t track,
                      int64_t ts,
                      int64_t dur,
                      uint32_t srcloc,
                      uint32_t depth,
                      uint32_t parent,
                      uint32_t name,
                      uint32_t text) {
    const SourceLocation& loc = source_locations_[srcloc];
    tables::SliceTable::Row row(ts, dur, TrackId(track), kNullStringId,
                                name == kNone ? loc.name : StringId::Raw(name));
    row.depth = depth;
    if (parent != kNone)
      row.parent_id = SliceId(parent);
    row.arg_set_id =
        text == kNone ? loc.arg_set_id : ArgSetWithText(srcloc, text);
    return slices_->Insert(row).id.value;
  }

  void InsertFrame(uint32_t track,
                   int64_t ts,
                   int64_t dur,
                   uint64_t frame_number) {
    tables::SliceTable::Row row(ts, dur, TrackId(track), kNullStringId,
                                frame_names_[track]);
    ArgsTracker::CompactArg arg;
    arg.flat_key = arg.key = frame_key_;
    arg.value = Variadic::UnsignedInteger(frame_number);
    row.arg_set_id = context_->args_tracker->AddArgSet(&arg, 1);
    slices_->Insert(row);
  }

  void InsertMessage(uint32_t track,
                     int64_t ts,
                     StringId text,
                     uint32_t color) {
    tables::SliceTable::Row row(ts, 0, TrackId(track), kNullStringId, text);
    if (color != 0) {
      ArgsTracker::CompactArg arg;
      arg.flat_key = arg.key = color_key_;
      arg.value = Variadic::UnsignedInteger(color);
      row.arg_set_id = context_->args_tracker->AddArgSet(&arg, 1);
    }
    slices_->Insert(row);
  }

  void InsertPlotPoint(uint32_t plot, int64_t ts, double value) {
    counters_->Insert({ts, TrackId(plot), value, {}});
  }

  bool drop_events() const { return drop_events_; }
  int64_t ts_offset() const { return ts_offset_; }
  StringId InternStringId(const char* str) {
    return storage_->InternString(str);
  }

 private:
  struct SourceLocation {
    StringId name;
    StringId function;
    StringId file;
    uint32_t line;
    // Shared by all the zones of this source location which have no text.
    ArgSetId arg_set_id;
  };

  // Returns what has to be added to a Tracy timestamp (nanoseconds since the
  // start of the capture) to get trace time, or nullopt if the capture cannot
  // be placed on the trace's timeline.
  //
  // The whole capture is shifted by one constant rather than converting each
  // event through the clock tracker. That keeps the order, the nesting and the
  // durations of the events intact whatever the shape of the clock graph (a
  // path with several snapshots is piecewise and need not be monotonic), and
  // costs nothing per event. The price is ignoring any drift of the clocks
  // during the capture.
  std::optional<int64_t> ComputeTsOffset(const TracyTimeRange& range) {
    using FileAlignment = TraceProcessorContext::TraceState::FileAlignment;
    ClockTracker* clocks = context_->clock_tracker.get();
    // Tracy timestamps can start slightly below zero.
    const int64_t shift = range.first_event_ns < 0 ? -range.first_event_ns : 0;

    // A perfetto_manifest pinned this file's private clock to a clock of
    // another trace at an explicit offset. That is a statement about the
    // capture's own timeline, so the private clock reads the (non-negative)
    // time since the start of the capture.
    if (context_->has_clock_override())
      return Sub(clocks->ConvertDefaultClockToTraceTime(shift), shift);

    std::optional<int64_t> by_clock = ComputeTsOffsetByClock(shift);

    // The capture is loaded together with other traces. The ones read before
    // it (all the traces of other formats, see archive_priority, and the
    // Tracy captures which precede it) have pushed their events to the sorter,
    // which therefore knows the time range they cover.
    const FileAlignment alignment = context_->trace_state
                                        ? context_->trace_state->file_alignment
                                        : FileAlignment::kAuto;
    std::optional<int64_t> others_start =
        context_->sorter->min_nonzero_timestamp();
    if (alignment == FileAlignment::kClock || !others_start)
      return by_clock;
    if (alignment == FileAlignment::kAuto && by_clock) {
      // Recorded together: the clocks say when. Recorded at different times
      // (the time ranges are disjoint): they are being opened together to be
      // compared, so lay them on top of one another instead.
      const int64_t others_end = context_->sorter->max_timestamp();
      const bool overlap = range.first_event_ns + *by_clock <= others_end &&
                           range.last_event_ns + *by_clock >= *others_start;
      if (overlap)
        return by_clock;
    }
    // Start when the others start. "Start" is the first zone rather than the
    // first event, which tends to be the synthetic frame at the very start of
    // the capture, before the program has done anything. Whatever precedes
    // the first zone must not go negative though.
    // If the earliest of the others is itself a Tracy capture, line up with
    // its first zone, for the same reason.
    if (load_state_->first_event_ts &&
        *load_state_->first_event_ts <= *others_start) {
      others_start = load_state_->first_zone_ts;
    }
    int64_t offset = *others_start - range.first_zone_ns;
    if (range.first_event_ns + offset < 0)
      offset = -range.first_event_ns;
    context_->stats_tracker->IncrementStats(stats::tracy_aligned_to_start);
    return offset;
  }

  // Where the capture goes if left to its clocks.
  std::optional<int64_t> ComputeTsOffsetByClock(int64_t shift) {
    constexpr int64_t kNsPerSec = 1000000000;
    ClockTracker* clocks = context_->clock_tracker.get();
    if (capture_time_s_ > 0) {
      // Tracy records the wall-clock time of the start of the capture (with a
      // resolution of one second). If the trace's timeline can be reached from
      // REALTIME (e.g. this capture is being merged with a Perfetto trace
      // which has clock snapshots) that lines the capture up with it.
      const int64_t wall = static_cast<int64_t>(capture_time_s_) * kNsPerSec;
      if (std::optional<int64_t> ts = clocks->ToTraceTime(
              ClockTracker::ClockId::Machine(
                  protos::pbzero::BUILTIN_CLOCK_REALTIME),
              wall, std::nullopt, /*suppress_errors=*/true)) {
        return ts;
      }
      // Otherwise the private clock of this file reads wall-clock time: on
      // its own this keeps timestamps well clear of zero, and several captures
      // opened together are still related by wall-clock.
      return clocks->ConvertDefaultClockToTraceTime(wall);
    }
    // No idea when the capture was taken. Timestamps close to zero trip up
    // consumers which look slightly before the start of the trace, so start
    // at an arbitrary positive time.
    constexpr int64_t kFallbackBaseNs = 3600 * kNsPerSec;
    return Sub(clocks->ConvertDefaultClockToTraceTime(kFallbackBaseNs + shift),
               shift);
  }

  static std::optional<int64_t> Sub(std::optional<int64_t> ts, int64_t delta) {
    return ts ? std::make_optional(*ts - delta) : std::nullopt;
  }

  UniqueTid GetOrCreateThread(uint64_t tid) {
    // UpdateThread() rather than GetOrCreateThreadWithParent() so that the
    // thread whose tid matches the pid is marked as the main thread.
    return context_->process_tracker->UpdateThread(static_cast<int64_t>(tid),
                                                   pid_);
  }

  ArgSetId AddArgSet(const SourceLocation& loc, StringId text) {
    ArgsTracker::CompactArg args[4];
    uint32_t count = 0;
    auto add = [&](StringId key, Variadic value) {
      args[count].flat_key = args[count].key = key;
      args[count].value = value;
      count++;
    };
    add(function_key_, Variadic::String(loc.function));
    add(file_key_, Variadic::String(loc.file));
    add(line_key_, Variadic::UnsignedInteger(loc.line));
    if (!text.is_null())
      add(text_key_, Variadic::String(text));
    return context_->args_tracker->AddArgSet(args, count);
  }

  // The text is per zone, but zones of a source location tend to share few
  // distinct texts (and Tracy deduplicates them), so the arg sets are cached.
  ArgSetId ArgSetWithText(uint32_t srcloc, uint32_t text) {
    uint64_t key = (static_cast<uint64_t>(srcloc) << 32) | text;
    auto [it, inserted] = text_arg_sets_.Insert(key, 0);
    if (inserted)
      *it = AddArgSet(source_locations_[srcloc], StringId::Raw(text));
    return *it;
  }

  TraceProcessorContext* const context_;
  TracyLoadState* const load_state_;
  TraceStorage* const storage_;
  tables::SliceTable* const slices_;
  tables::CounterTable* const counters_;
  const StringId function_key_;
  const StringId file_key_;
  const StringId line_key_;
  const StringId text_key_;
  const StringId frame_key_;
  const StringId color_key_;

  int64_t pid_ = kFallbackPid;
  // Added to every Tracy timestamp; see OnCaptureInfo().
  int64_t ts_offset_ = 0;
  bool drop_events_ = false;
  uint64_t capture_time_s_ = 0;
  UniquePid upid_ = 0;
  std::vector<SourceLocation> source_locations_;
  base::FlatHashMap<uint64_t, ArgSetId> text_arg_sets_;
  base::FlatHashMap<uint64_t, std::string> thread_names_;
  base::FlatHashMap<uint32_t, StringId> frame_names_;
};

StorageSink::~StorageSink() = default;

// An event of a Tracy capture on its way through the TraceSorter. The meaning
// of |args| depends on |kind|; see SortedEventSink::Parse().
struct TracyEvent {
  enum Kind : uint32_t { kZone, kFrame, kMessage, kPlotPoint };
  int64_t dur;  // The bits of the (double) value for kPlotPoint.
  Kind kind;
  uint32_t track;
  uint32_t args[6];
};
static_assert(sizeof(TracyEvent) == 40);

// The slow path, used when the Tracy capture is not the only trace being
// loaded (it is in an archive, possibly next to other traces). The storage
// tables must be filled in timestamp order across all the traces, which only
// the TraceSorter can arrange. The price is buffering every event.
//
// This is the receiving end: the sorter hands back the events in timestamp
// order once all the traces have been read.
class SortedEventSink : public TraceSorter::Sink<TracyEvent, SortedEventSink> {
 public:
  SortedEventSink(TraceProcessorContext* context, TracyLoadState* load_state)
      : storage_(context, load_state) {}
  ~SortedEventSink() override;

  StorageSink* storage() { return &storage_; }

  void Parse(int64_t ts, TracyEvent ev) {
    const uint32_t* a = ev.args;
    switch (ev.kind) {
      case TracyEvent::kZone: {
        // {srcloc, depth, parent, name, text, zone}. |zone| and |parent| are
        // indices in the order the zones were pushed; the sorter is stable so
        // a parent (which starts no later than its children and was pushed
        // before them) has always been inserted by now.
        uint32_t parent = TracySink::kNone;
        if (a[2] != TracySink::kNone && a[2] < slice_ids_.size())
          parent = slice_ids_[a[2]];
        if (a[5] >= slice_ids_.size())
          slice_ids_.resize(a[5] + 1, TracySink::kNone);
        slice_ids_[a[5]] = storage_.InsertZone(ev.track, ts, ev.dur, a[0], a[1],
                                               parent, a[3], a[4]);
        break;
      }
      case TracyEvent::kFrame:
        storage_.InsertFrame(ev.track, ts, ev.dur,
                             (static_cast<uint64_t>(a[1]) << 32) | a[0]);
        break;
      case TracyEvent::kMessage:
        storage_.InsertMessage(ev.track, ts, StringId::Raw(a[0]), a[1]);
        break;
      case TracyEvent::kPlotPoint: {
        double value;
        memcpy(&value, &ev.dur, sizeof(value));
        storage_.InsertPlotPoint(ev.track, ts, value);
        break;
      }
    }
  }

 private:
  StorageSink storage_;
  // Zone index -> id of its row in the slice table.
  std::vector<uint32_t> slice_ids_;
};

SortedEventSink::~SortedEventSink() = default;

// The sending end of the slow path: tracks, threads and interned data go
// straight to storage (their order does not matter) while events go to the
// sorter.
class SorterSink : public TracySink {
 public:
  SorterSink(StorageSink* storage, TraceSorter::Stream<TracyEvent>* stream)
      : storage_(storage), stream_(stream) {}
  ~SorterSink() override;

  void OnCaptureInfo(const TracyCaptureInfo& info) override {
    storage_->OnCaptureInfo(info);
  }
  void OnTimeRange(const TracyTimeRange& range) override {
    storage_->OnTimeRange(range);
  }
  uint32_t OnThreadTrack(uint64_t tid, const char* name, bool fiber) override {
    return storage_->OnThreadTrack(tid, name, fiber);
  }
  uint32_t OnMessageTrack(uint64_t tid) override {
    return storage_->OnMessageTrack(tid);
  }
  uint32_t OnFrameTrack(const char* name) override {
    return storage_->OnFrameTrack(name);
  }
  uint32_t OnGpuTrack(uint32_t context_index,
                      const char* context_name,
                      const char* context_type,
                      uint64_t tid) override {
    return storage_->OnGpuTrack(context_index, context_name, context_type, tid);
  }
  uint32_t OnPlot(const char* name, const char* type) override {
    return storage_->OnPlot(name, type);
  }
  uint32_t InternSourceLocation(const char* zone_name,
                                const char* function,
                                const char* file,
                                uint32_t line) override {
    return storage_->InternSourceLocation(zone_name, function, file, line);
  }
  uint32_t InternString(const char* str) override {
    return storage_->InternString(str);
  }

  uint32_t OnZone(uint32_t track,
                  int64_t ts,
                  int64_t dur,
                  uint32_t srcloc,
                  uint32_t depth,
                  uint32_t parent,
                  uint32_t name,
                  uint32_t text) override {
    const uint32_t zone = next_zone_++;
    Push(ts, {dur,
              TracyEvent::kZone,
              track,
              {srcloc, depth, parent, name, text, zone}});
    return zone;
  }

  void OnFrame(uint32_t track,
               int64_t ts,
               int64_t dur,
               uint64_t frame_number) override {
    Push(ts, {dur,
              TracyEvent::kFrame,
              track,
              {static_cast<uint32_t>(frame_number),
               static_cast<uint32_t>(frame_number >> 32), 0, 0, 0, 0}});
  }

  void OnMessage(uint32_t track,
                 int64_t ts,
                 const char* text,
                 uint32_t color) override {
    Push(ts, {0,
              TracyEvent::kMessage,
              track,
              {storage_->InternStringId(text).raw_id(), color, 0, 0, 0, 0}});
  }

  void OnPlotPoint(uint32_t plot, int64_t ts, double value) override {
    TracyEvent ev{0, TracyEvent::kPlotPoint, plot, {}};
    memcpy(&ev.dur, &value, sizeof(value));
    Push(ts, ev);
  }

 private:
  void Push(int64_t ts, TracyEvent ev) {
    if (!storage_->drop_events())
      stream_->Push(ts + storage_->ts_offset(), ev);
  }

  StorageSink* const storage_;
  TraceSorter::Stream<TracyEvent>* const stream_;
  uint32_t next_zone_ = 0;
};

SorterSink::~SorterSink() = default;

}  // namespace

bool IsTracyCapture(const uint8_t* data, size_t size) {
  // See TracyFileHeader.hpp: respectively the current container (any
  // compression, multi-stream) and the legacy LZ4 and Zstd ones.
  static constexpr uint8_t kMagics[][4] = {
      {'t', 'r', 253, 'P'},
      {'t', 'l', 'Z', 4},
      {'t', 'Z', 's', 't'},
  };
  if (size < 4)
    return false;
  for (const auto& magic : kMagics) {
    if (memcmp(data, magic, 4) == 0)
      return true;
  }
  return false;
}

TracyTraceReader::TracyTraceReader(TraceProcessorContext* context,
                                   uint32_t file_id,
                                   TracyLoadState* load_state)
    : context_(context),
      is_only_trace_(file_id == 0),
      load_state_(load_state) {}

TracyTraceReader::~TracyTraceReader() = default;

base::Status TracyTraceReader::Parse(TraceBlobView blob) {
  if (!spool_) {
    base::StatusOr<base::TempFile> file = base::TempFile::Create();
    RETURN_IF_ERROR(file.status());
    spool_ = std::move(*file);
  }
  if (base::WriteAll(spool_->fd(), blob.data(), blob.size()) !=
      static_cast<ssize_t>(blob.size())) {
    return base::ErrStatus(
        "tracy: failed to write the capture to the temporary file %s",
        spool_->path().c_str());
  }
  return base::OkStatus();
}

base::Status TracyTraceReader::OnPushDataToSorter() {
  if (!spool_)
    return base::ErrStatus("tracy: empty capture");

  TracyImportStats stats;
  char error[512];
  bool ok;
  if (is_only_trace_) {
    // Nothing else writes events into storage during this load, and the
    // bridge delivers events in timestamp order: write them directly.
    StorageSink sink(context_, load_state_);
    ok = ImportTracyFile(spool_->path().c_str(), &sink, &stats, error,
                         sizeof(error));
  } else {
    auto sorted_sink = std::make_unique<SortedEventSink>(context_, load_state_);
    StorageSink* storage = sorted_sink->storage();
    // The sorter owns the sink and hands it the events during extraction,
    // i.e. after this function has returned.
    auto stream = context_->sorter->CreateStream(std::move(sorted_sink));
    SorterSink sink(storage, stream.get());
    ok = ImportTracyFile(spool_->path().c_str(), &sink, &stats, error,
                         sizeof(error));
  }
  spool_.reset();
  if (!ok)
    return base::ErrStatus("tracy: %s", error);

  context_->stats_tracker->SetStats(
      stats::tracy_out_of_order_events,
      static_cast<int64_t>(stats.out_of_order_events));
  if (getenv("PERFETTO_TRACY_IMPORTER_STATS")) {
    PERFETTO_LOG(
        "tracy: load %.3f s, emit %.3f s; %llu zones, %llu GPU zones, %llu "
        "frames, %llu messages, %llu plot points, %llu out of order",
        stats.load_seconds, stats.emit_seconds,
        static_cast<unsigned long long>(stats.zones),
        static_cast<unsigned long long>(stats.gpu_zones),
        static_cast<unsigned long long>(stats.frames),
        static_cast<unsigned long long>(stats.messages),
        static_cast<unsigned long long>(stats.plot_points),
        static_cast<unsigned long long>(stats.out_of_order_events));
  }
  return base::OkStatus();
}

}  // namespace perfetto::trace_processor::tracy_importer
