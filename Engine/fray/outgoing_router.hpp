/* outgoing_router.hpp */

#ifndef _FRAY_OUTGOING_ROUTER_HPP_
#define _FRAY_OUTGOING_ROUTER_HPP_

#include <chrono>
#include <cstddef>
#include <cstdint>
#include <deque>
#include <functional>
#include <map>
#include <optional>
#include <utility>
#include <vector>

namespace fray
{
    namespace routing
    {
        enum class NeighborState { unknown, probing, ready, suspect, degraded, down, unreachable };
        // The router thread's single source of truth about which neighbors are ready, plus the messages waiting for them.
        // Nothing here is thread safe: only the router thread may touch it. Nothing waits on a neighbor either.
        // A message for a neighbor that is not ready stays in its queue until the neighbor says it is ready,
        // its time to live runs out, or the neighbor is declared down and its queue is discarded.
        template <class Key, class Frame>
        class OutgoingRouter
        {
        public:
            using Clock = std::chrono::steady_clock;
            using Deliver = std::function<void(Key, const Frame &)>;
            using Now = std::function<Clock::time_point()>;
            struct QueueHealth
            {
                Key destination;
                size_t depth;
                uint64_t oldestAgeMs;
            };

            explicit OutgoingRouter(Deliver deliver, Now now = [] { return Clock::now(); })
                : _deliver(std::move(deliver)), _now(std::move(now)) {}

            NeighborState state(Key neighbor) const
            {
                const auto found = _states.find(neighbor);
                return found == _states.end() ? NeighborState::unknown : found->second;
            }

            bool isReady(Key neighbor) const { return state(neighbor) == NeighborState::ready; }

            bool setState(Key neighbor, NeighborState value)
            {
                if (value == NeighborState::ready) return markReady(neighbor);
                if (state(neighbor) == value) return false;
                _states[neighbor] = value;
                return true;
            }

            // Number of messages still waiting for the neighbor.
            size_t queued(Key neighbor) const
            {
                const auto found = _queues.find(neighbor);
                return found == _queues.end() ? 0 : found->second.size();
            }

            std::vector<QueueHealth> queueHealth() const
            {
                std::vector<QueueHealth> result;
                const auto now = _now();
                for (const auto &[neighbor, queue] : _queues)
                {
                    if (queue.empty()) continue;
                    const auto age = std::chrono::duration_cast<std::chrono::milliseconds>(now - queue.front().queuedAt);
                    result.push_back({neighbor, queue.size(), static_cast<uint64_t>(age.count() < 0 ? 0 : age.count())});
                }
                return result;
            }

            // Marks the neighbor ready and delivers its waiting messages in order, skipping any that expired.
            // Returns true only when the neighbor was not ready before, so callers act once per transition.
            bool markReady(Key neighbor)
            {
                if (isReady(neighbor))
                    return false;
                _states[neighbor] = NeighborState::ready;
                const auto found = _queues.find(neighbor);
                if (found == _queues.end())
                    return true;
                auto waiting = std::move(found->second);
                _queues.erase(found);
                const auto now = _now();
                for (auto &entry : waiting)
                    if (!entry.expires || *entry.expires > now)
                        _deliver(neighbor, entry.frame);
                return true;
            }

            // The neighbor can no longer be reached for now. Messages sent to it wait in its queue again.
            // Returns true when it was ready before.
            bool markNotReady(Key neighbor)
            {
                const bool wasReady = isReady(neighbor);
                _states.erase(neighbor);
                return wasReady;
            }

            // For a neighbor declared down or unreachable: what was waiting for it may no longer make sense, so it is
            // dropped. Returns how many messages were dropped.
            size_t discardQueue(Key neighbor)
            {
                const auto found = _queues.find(neighbor);
                if (found == _queues.end())
                    return 0;
                const size_t discarded = found->second.size();
                _queues.erase(found);
                return discarded;
            }

            // Delivers now if the neighbor is ready, otherwise queues. ttlMs 0 means the message never expires.
            // Returns true when the message was delivered immediately.
            bool send(Key neighbor, Frame frame, uint32_t ttlMs)
            {
                if (isReady(neighbor))
                {
                    _deliver(neighbor, frame);
                    return true;
                }
                sweep();
                const auto now = _now();
                Entry entry{std::move(frame), now, std::nullopt};
                if (ttlMs > 0)
                    entry.expires = now + std::chrono::milliseconds(ttlMs);
                _queues[neighbor].push_back(std::move(entry));
                return false;
            }

            // Drops every queued message whose time to live has run out. Returns how many were dropped.
            size_t sweep()
            {
                const auto now = _now();
                size_t dropped = 0;
                for (auto queue = _queues.begin(); queue != _queues.end();)
                {
                    auto &entries = queue->second;
                    for (auto entry = entries.begin(); entry != entries.end();)
                    {
                        if (entry->expires && *entry->expires <= now)
                        {
                            entry = entries.erase(entry);
                            ++dropped;
                        }
                        else
                            ++entry;
                    }
                    queue = entries.empty() ? _queues.erase(queue) : std::next(queue);
                }
                return dropped;
            }

        private:
            struct Entry
            {
                Frame frame;
                Clock::time_point queuedAt;
                std::optional<Clock::time_point> expires;
            };

            Deliver _deliver;
            Now _now;
            std::map<Key, NeighborState> _states;
            std::map<Key, std::deque<Entry>> _queues;
        };
    }
}

#endif
