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

// NOTE: this file is compiled with Tracy's flags (C++20, exceptions, RTTI),
// not with trace processor's. It must not include any Perfetto header other
// than tracy_bridge.h. See the comment in that file.

#include "src/trace_processor/plugins/tracy_importer/tracy_bridge.h"

#include <algorithm>
#include <chrono>
#include <cstdio>
#include <cstring>
#include <exception>
#include <limits>
#include <memory>
#include <unordered_map>
#include <vector>

#include "TracyFileRead.hpp"
#include "TracyWorker.hpp"

namespace perfetto::trace_processor::tracy_importer {

TracySink::~TracySink() = default;

namespace {

using Clock = std::chrono::steady_clock;

double SecondsSince(Clock::time_point start) {
  return std::chrono::duration<double>(Clock::now() - start).count();
}

const char* GpuContextTypeName(tracy::GpuContextType type) {
  static const char* const kNames[] = {
      "Invalid", "OpenGL", "Vulkan", "OpenCL",  "Direct3D12", "Direct3D11",
      "Metal",   "Custom", "CUDA",   "Rocprof", "WebGPU"};
  auto idx = static_cast<size_t>(type);
  return idx < sizeof(kNames) / sizeof(kNames[0]) ? kNames[idx] : "Unknown";
}

const char* PlotTypeName(tracy::PlotType type) {
  switch (type) {
    case tracy::PlotType::User:
      return "User";
    case tracy::PlotType::Memory:
      return "Memory";
    case tracy::PlotType::SysTime:
      return "SysTime";
    case tracy::PlotType::Power:
      return "Power";
  }
  return "Unknown";
}

// Tracy stores the children of a zone either as an array of zones ("magic"
// vectors, always the case for captures loaded from a file) or as an array of
// pointers to zones. This hides the difference.
template <typename Event>
struct EventSpan {
  const Event* inline_events = nullptr;
  const tracy::short_ptr<Event>* ptr_events = nullptr;
  uint32_t size = 0;

  explicit EventSpan(const tracy::Vector<tracy::short_ptr<Event>>& vec) {
    size = static_cast<uint32_t>(vec.size());
    if (vec.is_magic()) {
      inline_events =
          reinterpret_cast<const tracy::Vector<Event>*>(&vec)->data();
    } else {
      ptr_events = vec.data();
    }
  }

  const Event& operator[](uint32_t i) const {
    return inline_events ? inline_events[i] : *ptr_events[i];
  }
};

// Interns Tracy's source locations and strings into the sink, at most once
// each.
class Interner {
 public:
  Interner(const tracy::Worker& worker, TracySink* sink)
      : worker_(worker), sink_(sink), srclocs_(1u << 16, TracySink::kNone) {}

  uint32_t SourceLocation(int16_t id) {
    uint32_t& handle = srclocs_[static_cast<uint16_t>(id)];
    if (handle == TracySink::kNone) {
      const tracy::SourceLocation& sl = worker_.GetSourceLocation(id);
      handle = sink_->InternSourceLocation(worker_.GetZoneName(sl),
                                           worker_.GetString(sl.function),
                                           worker_.GetString(sl.file), sl.line);
    }
    return handle;
  }

  uint32_t String(const tracy::StringIdx& idx) {
    auto [it, inserted] = strings_.try_emplace(idx.Idx(), 0u);
    if (inserted)
      it->second = sink_->InternString(worker_.GetString(idx));
    return it->second;
  }

 private:
  const tracy::Worker& worker_;
  TracySink* const sink_;
  std::vector<uint32_t> srclocs_;
  std::unordered_map<uint32_t, uint32_t> strings_;
};

// A lazily-walked, depth-first (pre-order) traversal of the CPU zones of one
// thread. Pre-order of a properly nested zone tree is ordered by start time.
class ZoneCursor {
 public:
  ZoneCursor(const tracy::Worker& worker,
             const tracy::ThreadData& thread,
             uint32_t track)
      : worker_(worker), track_(track) {
    Push(EventSpan<tracy::ZoneEvent>(thread.timeline), TracySink::kNone);
    LoadTs();
  }

  bool done() const { return stack_.empty(); }
  int64_t ts() const { return ts_; }

  // Emits the current zone and moves to the next one.
  void Emit(TracySink* sink, Interner* interner, TracyImportStats* stats) {
    Level& level = stack_.back();
    const tracy::ZoneEvent& zone = level.span[level.idx];
    const int64_t dur =
        zone.IsEndValid() ? std::max<int64_t>(zone.End() - ts_, 0) : -1;
    uint32_t name = TracySink::kNone;
    uint32_t text = TracySink::kNone;
    if (zone.extra != 0) {
      const tracy::ZoneExtra& extra = worker_.GetZoneExtra(zone);
      if (extra.name.Active())
        name = interner->String(extra.name);
      if (extra.text.Active())
        text = interner->String(extra.text);
    }
    const uint32_t id = sink->OnZone(
        track_, ts_, dur, interner->SourceLocation(zone.SrcLoc()),
        static_cast<uint32_t>(stack_.size() - 1), level.parent, name, text);
    stats->zones++;

    level.idx++;
    if (zone.HasChildren()) {
      // Might invalidate |level| and |zone|.
      Push(EventSpan<tracy::ZoneEvent>(worker_.GetZoneChildren(zone.Child())),
           id);
    }
    while (!stack_.empty() && stack_.back().idx == stack_.back().span.size)
      stack_.pop_back();
    const int64_t prev_ts = ts_;
    LoadTs();
    if (!stack_.empty() && ts_ < prev_ts) {
      stats->out_of_order_events++;
      ts_ = prev_ts;
    }
  }

 private:
  struct Level {
    EventSpan<tracy::ZoneEvent> span;
    uint32_t idx;
    uint32_t parent;
  };

  void Push(EventSpan<tracy::ZoneEvent> span, uint32_t parent) {
    if (span.size > 0)
      stack_.push_back(Level{span, 0, parent});
  }

  void LoadTs() {
    if (!stack_.empty())
      ts_ = stack_.back().span[stack_.back().idx].Start();
  }

  const tracy::Worker& worker_;
  const uint32_t track_;
  std::vector<Level> stack_;
  int64_t ts_ = 0;
};

// Everything which is not a CPU zone is orders of magnitude less frequent and
// is not necessarily stored ordered, so is flattened and sorted instead.
struct MiscEvent {
  enum Kind : uint8_t { kGpuZone, kFrame, kMessage };
  int64_t ts;
  int64_t dur;
  Kind kind;
  uint32_t track;
  uint32_t depth;    // kGpuZone.
  uint32_t parent;   // kGpuZone: index of the parent in the vector or kNone.
  int16_t srcloc;    // kGpuZone.
  uint64_t frame;    // kFrame.
  const char* text;  // kMessage.
  uint32_t color;    // kMessage.
};

void FlattenGpuZones(const tracy::Worker& worker,
                     const tracy::Vector<tracy::short_ptr<tracy::GpuEvent>>& v,
                     uint32_t track,
                     uint32_t depth,
                     uint32_t parent,
                     std::vector<MiscEvent>* out) {
  EventSpan<tracy::GpuEvent> span(v);
  for (uint32_t i = 0; i < span.size; i++) {
    const tracy::GpuEvent& ev = span[i];
    MiscEvent me{};
    me.kind = MiscEvent::kGpuZone;
    me.ts = ev.GpuStart();
    me.dur = ev.GpuEnd() >= 0 ? std::max<int64_t>(ev.GpuEnd() - me.ts, 0) : -1;
    me.track = track;
    me.depth = depth;
    me.parent = parent;
    me.srcloc = ev.SrcLoc();
    const auto idx = static_cast<uint32_t>(out->size());
    out->push_back(me);
    if (ev.Child() >= 0) {
      FlattenGpuZones(worker, worker.GetGpuChildren(ev.Child()), track,
                      depth + 1, idx, out);
    }
  }
}

void Emit(const tracy::Worker& worker,
          TracySink* sink,
          TracyImportStats* stats) {
  TracyCaptureInfo info{};
  info.capture_name = worker.GetCaptureName().c_str();
  info.capture_program = worker.GetCaptureProgram().c_str();
  info.host_info = worker.GetHostInfo().c_str();
  info.pid = worker.GetPid();
  info.capture_time_s = worker.GetCaptureTime();
  info.first_time_ns = worker.GetFirstTime();
  info.last_time_ns = worker.GetLastTime();
  info.file_version = static_cast<uint32_t>(worker.GetTraceVersion());
  sink->OnCaptureInfo(info);

  Interner interner(worker, sink);

  // Threads and their CPU zones.
  std::vector<ZoneCursor> cursors;
  for (const tracy::ThreadData* td : worker.GetThreadData()) {
    if (!td)
      continue;
    const uint32_t track =
        sink->OnThreadTrack(td->id, worker.GetThreadName(td->id), td->isFiber);
    if (!td->timeline.empty())
      cursors.emplace_back(worker, *td, track);
  }

  // GPU zones, frames and messages.
  std::vector<MiscEvent> misc;
  uint32_t gpu_ctx_idx = 0;
  for (const tracy::GpuCtxData* ctx : worker.GetGpuData()) {
    const uint32_t ctx_idx = gpu_ctx_idx++;
    if (!ctx)
      continue;
    const char* name = ctx->name.Active() ? worker.GetString(ctx->name) : "";
    for (const auto& [tid, thread_data] : ctx->threadData) {
      const uint32_t track =
          sink->OnGpuTrack(ctx_idx, name, GpuContextTypeName(ctx->type), tid);
      const size_t before = misc.size();
      FlattenGpuZones(worker, thread_data.timeline, track, 0, TracySink::kNone,
                      &misc);
      stats->gpu_zones += misc.size() - before;
    }
  }
  for (const tracy::FrameData* fd : worker.GetFrames()) {
    if (!fd)
      continue;
    const uint32_t track = sink->OnFrameTrack(worker.GetString(fd->name));
    const size_t count = worker.GetFrameCount(*fd);
    for (size_t i = 0; i < count; i++) {
      MiscEvent me{};
      me.kind = MiscEvent::kFrame;
      me.ts = worker.GetFrameBegin(*fd, i);
      me.dur = std::max<int64_t>(worker.GetFrameEnd(*fd, i) - me.ts, 0);
      me.track = track;
      me.frame = i;
      misc.push_back(me);
    }
    stats->frames += count;
  }
  {
    std::unordered_map<uint64_t, uint32_t> message_tracks;
    for (const auto& msg_ptr : worker.GetMessages()) {
      const tracy::MessageData& msg = *msg_ptr;
      const uint64_t tid = worker.DecompressThread(msg.thread);
      auto [it, inserted] = message_tracks.try_emplace(tid, 0u);
      if (inserted)
        it->second = sink->OnMessageTrack(tid);
      MiscEvent me{};
      me.kind = MiscEvent::kMessage;
      me.ts = msg.time;
      me.track = it->second;
      me.text = worker.GetString(msg.ref);
      me.color = msg.color;
      misc.push_back(me);
      stats->messages++;
    }
  }
  // Sort indices rather than events as |parent| refers to positions in
  // |misc|. Stable, so that a GPU zone stays after its parent when both start
  // at the same time.
  std::vector<uint32_t> misc_order(misc.size());
  for (uint32_t i = 0; i < misc_order.size(); i++)
    misc_order[i] = i;
  std::stable_sort(
      misc_order.begin(), misc_order.end(),
      [&misc](uint32_t a, uint32_t b) { return misc[a].ts < misc[b].ts; });
  std::vector<uint32_t> misc_handles(misc.size(), TracySink::kNone);
  size_t next_misc = 0;

  auto emit_misc = [&](uint32_t idx) {
    const MiscEvent& me = misc[idx];
    switch (me.kind) {
      case MiscEvent::kGpuZone: {
        uint32_t parent = TracySink::kNone;
        uint32_t depth = me.depth;
        if (me.parent != TracySink::kNone) {
          parent = misc_handles[me.parent];
          // Only possible if a child starts before its parent.
          if (parent == TracySink::kNone) {
            depth = 0;
            stats->out_of_order_events++;
          }
        }
        misc_handles[idx] = sink->OnZone(
            me.track, me.ts, me.dur, interner.SourceLocation(me.srcloc), depth,
            parent, TracySink::kNone, TracySink::kNone);
        break;
      }
      case MiscEvent::kFrame:
        sink->OnFrame(me.track, me.ts, me.dur, me.frame);
        break;
      case MiscEvent::kMessage:
        sink->OnMessage(me.track, me.ts, me.text, me.color);
        break;
    }
  };
  auto emit_misc_until = [&](int64_t ts) {
    while (next_misc < misc_order.size() &&
           misc[misc_order[next_misc]].ts <= ts) {
      emit_misc(misc_order[next_misc++]);
    }
  };

  // Plots (emitted last, see below).
  struct PlotCursor {
    const tracy::PlotItem* cur;
    const tracy::PlotItem* end;
    uint32_t handle;
  };
  std::vector<PlotCursor> plots;
  for (const tracy::PlotData* pd : worker.GetPlots()) {
    if (!pd || pd->data.empty())
      continue;
    const uint32_t handle =
        sink->OnPlot(worker.GetString(pd->name), PlotTypeName(pd->type));
    plots.push_back(PlotCursor{pd->data.begin(), pd->data.end(), handle});
  }

  // Tell the sink what is coming, so it can decide where the capture goes on
  // its timeline before the first event.
  {
    constexpr int64_t kMax = std::numeric_limits<int64_t>::max();
    int64_t first_zone = kMax;
    for (const ZoneCursor& cursor : cursors) {
      if (!cursor.done())
        first_zone = std::min(first_zone, cursor.ts());
    }
    int64_t first_event = first_zone;
    if (!misc_order.empty())
      first_event = std::min(first_event, misc[misc_order[0]].ts);
    for (const PlotCursor& plot : plots)
      first_event = std::min(first_event, plot.cur->time.Val());
    TracyTimeRange range{};
    range.first_event_ns = first_event == kMax ? 0 : first_event;
    range.first_zone_ns =
        first_zone == kMax ? range.first_event_ns : first_zone;
    range.last_event_ns =
        std::max<int64_t>(worker.GetLastTime(), range.first_event_ns);
    sink->OnTimeRange(range);
  }

  // K-way merge of the per-thread zone streams (each already ordered by time)
  // so that the sink sees one globally ordered stream. The heap holds indices
  // into |cursors|, with the earliest timestamp at the front.
  auto later = [&cursors](uint32_t a, uint32_t b) {
    return cursors[a].ts() > cursors[b].ts();
  };
  std::vector<uint32_t> heap;
  for (uint32_t i = 0; i < cursors.size(); i++) {
    if (!cursors[i].done())
      heap.push_back(i);
  }
  std::make_heap(heap.begin(), heap.end(), later);
  while (!heap.empty()) {
    std::pop_heap(heap.begin(), heap.end(), later);
    ZoneCursor& cursor = cursors[heap.back()];
    // Threads tend to emit runs of zones: keep draining this cursor for as long
    // as it stays the earliest, instead of re-heapifying for every zone.
    const int64_t limit = heap.size() > 1 ? cursors[heap.front()].ts()
                                          : std::numeric_limits<int64_t>::max();
    do {
      emit_misc_until(cursor.ts());
      cursor.Emit(sink, &interner, stats);
    } while (!cursor.done() && cursor.ts() <= limit);
    if (cursor.done()) {
      heap.pop_back();
    } else {
      std::push_heap(heap.begin(), heap.end(), later);
    }
  }
  emit_misc_until(std::numeric_limits<int64_t>::max());

  // Plots: each is ordered by time; merge them the same way as the zones.
  auto plot_later = [](const PlotCursor& a, const PlotCursor& b) {
    return a.cur->time.Val() > b.cur->time.Val();
  };
  std::make_heap(plots.begin(), plots.end(), plot_later);
  int64_t last_plot_ts = std::numeric_limits<int64_t>::min();
  while (!plots.empty()) {
    std::pop_heap(plots.begin(), plots.end(), plot_later);
    PlotCursor& plot = plots.back();
    const int64_t limit = plots.size() > 1
                              ? plots.front().cur->time.Val()
                              : std::numeric_limits<int64_t>::max();
    do {
      int64_t ts = plot.cur->time.Val();
      if (ts < last_plot_ts) {
        stats->out_of_order_events++;
        ts = last_plot_ts;
      }
      last_plot_ts = ts;
      sink->OnPlotPoint(plot.handle, ts, plot.cur->val);
      stats->plot_points++;
      ++plot.cur;
    } while (plot.cur != plot.end && plot.cur->time.Val() <= limit);
    if (plot.cur == plot.end) {
      plots.pop_back();
    } else {
      std::push_heap(plots.begin(), plots.end(), plot_later);
    }
  }
}

}  // namespace

bool ImportTracyFile(const char* path,
                     TracySink* sink,
                     TracyImportStats* stats,
                     char* err,
                     size_t err_size) {
  *stats = TracyImportStats{};
  auto fail = [&](const char* msg) {
    snprintf(err, err_size, "%s", msg);
    return false;
  };
  try {
    const auto load_start = Clock::now();
    std::unique_ptr<tracy::FileRead> file(tracy::FileRead::Open(path));
    if (!file)
      return fail("failed to open the Tracy capture");
    // Only what is imported is loaded: locks, memory events, frame images,
    // context switches, callstack samples, symbol code and the source cache
    // are skipped. Background tasks (which only compute statistics used by
    // Tracy's UI) are disabled.
    const auto mask = static_cast<tracy::EventType::Type>(
        tracy::EventType::Messages | tracy::EventType::Plots);
    tracy::Worker worker(*file, mask, /*bgTasks=*/false);
    file.reset();
    stats->load_seconds = SecondsSince(load_start);

    const auto emit_start = Clock::now();
    Emit(worker, sink, stats);
    stats->emit_seconds = SecondsSince(emit_start);
    return true;
  } catch (const tracy::NotTracyDump&) {
    return fail("not a Tracy capture");
  } catch (const tracy::FileReadError&) {
    return fail("the Tracy capture is truncated or corrupted");
  } catch (const tracy::UnsupportedVersion& e) {
    return fail(e.msg.c_str());
  } catch (const tracy::LegacyVersion&) {
    return fail(
        "the Tracy capture is too old for the Tracy version trace processor "
        "was built with; convert it with Tracy's `update` tool");
  } catch (const tracy::LoadFailure& e) {
    return fail(e.msg.c_str());
  } catch (const std::exception& e) {
    return fail(e.what());
  }
}

}  // namespace perfetto::trace_processor::tracy_importer
