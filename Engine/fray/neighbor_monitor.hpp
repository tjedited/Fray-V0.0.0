#ifndef FRAY_NEIGHBOR_MONITOR_HPP
#define FRAY_NEIGHBOR_MONITOR_HPP

#include <chrono>
#include <functional>
#include <map>
#include <optional>
#include <utility>
#include <vector>

#include "outgoing_router.hpp"

namespace fray::routing
{
    enum class MonitorCommand { probe, ping };

    template <class Key>
    class NeighborMonitor
    {
    public:
        using Clock = std::chrono::steady_clock;
        using Now = std::function<Clock::time_point()>;
        using Send = std::function<void(Key, MonitorCommand)>;
        using State = std::function<NeighborState(Key)>;
        using Changed = std::function<void(Key, NeighborState)>;
        struct QueueHealth { Key destination; uint64_t depth; uint64_t oldestAgeMs; };
        struct HealthReport
        {
            uint64_t processedCount;
            uint64_t progressAgeMs;
            uint64_t heartbeat;
            std::vector<QueueHealth> queues;
        };

        NeighborMonitor(
            Send send,
            State state,
            Changed changed,
            Now now = [] { return Clock::now(); })
            : _send(std::move(send)), _state(std::move(state)), _changed(std::move(changed)), _now(std::move(now)) {}

        void start(
            Key neighbor)
        {
            const auto now = _now();
            _neighbors[neighbor] = {now, now, std::nullopt, std::nullopt, now, now, now};
            setState(neighbor, NeighborState::probing);
        }

        void observe(
            Key neighbor,
            bool ready)
        {
            auto found = _neighbors.find(neighbor);
            if (found == _neighbors.end()) return;
            auto &entry = found->second;
            entry.lastHeard = _now();
            if (ready && !entry.healthExpectedSince) entry.healthExpectedSince = entry.lastHeard;
            const auto state = _state(neighbor);
            if (state != NeighborState::degraded &&
                (ready || state == NeighborState::suspect || state == NeighborState::down))
                setState(neighbor, isDegraded(entry, entry.lastHeard) ? NeighborState::degraded : NeighborState::ready);
        }

        void report(
            Key neighbor,
            HealthReport health)
        {
            const auto found = _neighbors.find(neighbor);
            if (found == _neighbors.end()) return;
            auto &entry = found->second;
            const auto now = _now();
            if (!entry.health || entry.health->heartbeat != health.heartbeat) entry.heartbeatChanged = now;
            const bool queued = hasQueue(health);
            const bool wasQueued = entry.health && hasQueue(*entry.health);
            if (!queued || !wasQueued || entry.health->processedCount != health.processedCount)
                entry.queueProgress = now;
            entry.health = std::move(health);
            entry.healthReceived = now;
        }

        void tick()
        {
            using namespace std::chrono_literals;
            const auto now = _now();
            for (auto &[neighbor, entry] : _neighbors)
            {
                const auto state = _state(neighbor);
                if (state == NeighborState::probing)
                {
                    if (now - entry.since >= 10s) setState(neighbor, NeighborState::unreachable);
                    else _send(neighbor, MonitorCommand::probe);
                }
                else if (state == NeighborState::ready || state == NeighborState::suspect ||
                         state == NeighborState::degraded ||
                         state == NeighborState::down)
                {
                    const auto silence = now - entry.lastHeard;
                    if (silence >= 10s) setState(neighbor, NeighborState::down);
                    else if (silence >= 3s) setState(neighbor, NeighborState::suspect);
                    else if (isDegraded(entry, now)) setState(neighbor, NeighborState::degraded);
                    else if (state == NeighborState::degraded) setState(neighbor, NeighborState::ready);
                    _send(neighbor, MonitorCommand::ping);
                }
            }
        }

    private:
        struct Neighbor
        {
            Clock::time_point since;
            Clock::time_point lastHeard;
            std::optional<Clock::time_point> healthExpectedSince;
            std::optional<HealthReport> health;
            Clock::time_point healthReceived;
            Clock::time_point heartbeatChanged;
            Clock::time_point queueProgress;
        };
        static bool hasQueue(
            const HealthReport &health)
        {
            for (const auto &queue : health.queues) if (queue.depth != 0) return true;
            return false;
        }
        static bool isDegraded(
            const Neighbor &entry,
            Clock::time_point now)
        {
            using namespace std::chrono_literals;
            if (!entry.health)
                return entry.healthExpectedSince && now - *entry.healthExpectedSince >= 3s;
            return now - entry.healthReceived >= 3s || now - entry.heartbeatChanged >= 3s ||
                (hasQueue(*entry.health) && now - entry.queueProgress >= 3s);
        }
        void setState(
            Key neighbor,
            NeighborState state)
        {
            if (_state(neighbor) != state) _changed(neighbor, state);
        }
        Send _send;
        State _state;
        Changed _changed;
        Now _now;
        std::map<Key, Neighbor> _neighbors;
    };
}
#endif
