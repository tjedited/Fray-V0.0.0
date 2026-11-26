#include "fray/outgoing_router.hpp"
#include "fray/neighbor_monitor.hpp"

#include <cassert>
#include <chrono>
#include <iostream>
#include <string>
#include <utility>
#include <vector>

using namespace std::chrono_literals;
using Router = fray::routing::OutgoingRouter<int, std::string>;

int main()
{
    auto clock = Router::Clock::now();
    std::vector<std::pair<int, std::string>> delivered;
    Router router([&](int neighbor, const std::string &frame) { delivered.emplace_back(neighbor, frame); },
                  [&] { return clock; });

    // Nothing is delivered to a neighbor that is not ready; it waits in order.
    assert(!router.send(1, "a", 0));
    assert(!router.send(1, "b", 0));
    assert(!router.send(2, "other", 0));
    assert(delivered.empty() && router.queued(1) == 2 && router.queued(2) == 1);

    // Becoming ready delivers that neighbor's queue in order and leaves the others waiting.
    assert(router.markReady(1));
    assert(!router.markReady(1));
    assert((delivered == std::vector<std::pair<int, std::string>>{{1, "a"}, {1, "b"}}));
    assert(router.queued(1) == 0 && router.queued(2) == 1);

    // A ready neighbor gets its messages at once.
    assert(router.send(1, "c", 0));
    assert(delivered.back().second == "c");

    // A message past its time to live is dropped, one with ttl 0 never is.
    delivered.clear();
    assert(!router.send(3, "short", 100));
    assert(!router.send(3, "forever", 0));
    assert(!router.send(3, "long", 1000));
    clock += 200ms;
    assert(router.sweep() == 1 && router.queued(3) == 2);
    clock += 10s;
    assert(router.markReady(3));
    assert((delivered == std::vector<std::pair<int, std::string>>{{3, "forever"}}));

    // An expired message is also skipped when the queue is flushed without a sweep.
    delivered.clear();
    assert(!router.send(4, "stale", 50));
    clock += 100ms;
    assert(router.markReady(4) && delivered.empty());

    // A neighbor that is no longer ready queues again, and its queue is only dropped when it is declared down.
    assert(router.markNotReady(4) && !router.markNotReady(4) && !router.isReady(4));
    assert(!router.send(4, "x", 0) && !router.send(4, "y", 0));
    assert(router.discardQueue(4) == 2 && router.queued(4) == 0 && router.discardQueue(4) == 0);
    assert(!router.send(4, "z", 0));
    assert(router.markReady(4) && delivered.size() == 1 && delivered[0].second == "z");

    using Monitor = fray::routing::NeighborMonitor<int>;
    using State = fray::routing::NeighborState;
    using Command = fray::routing::MonitorCommand;
    std::vector<std::pair<int, State>> states;
    std::vector<std::pair<int, Command>> sent;
    Monitor monitor([&](int id, Command command) { sent.emplace_back(id, command); },
                    [&](int id) { return router.state(id); },
                    [&](int id, State state) { router.setState(id, state); states.emplace_back(id, state); },
                    [&] { return clock; });
    monitor.start(1);
    states.clear();
    clock += 1s;
    monitor.tick();
    monitor.observe(1, false);
    assert(states.empty() && sent.size() == 1 && sent[0].second == Command::probe);
    clock += 9s;
    monitor.tick();
    assert(states.back().second == State::unreachable);
    monitor.observe(1, true);
    assert(states.back().second == State::ready);
    clock += 3s;
    monitor.tick();
    assert(states.back().second == State::suspect && sent.back().second == Command::ping);
    clock += 7s;
    monitor.tick();
    assert(states.back().second == State::down);
    monitor.report(1, {0, 0, 1, {}});
    monitor.observe(1, false);
    assert(states.back().second == State::ready);

    auto sample = [&](uint64_t heartbeat, uint64_t processed, uint64_t depth)
    {
        Monitor::HealthReport health{processed, 0, heartbeat, {}};
        if (depth) health.queues.push_back({2, depth, 0});
        monitor.report(1, std::move(health));
        monitor.observe(1, false);
        monitor.tick();
    };
    sample(1, 0, 0);
    for (int i = 0; i < 3; ++i) { clock += 1s; sample(1, 0, 0); }
    assert(router.state(1) == State::degraded);
    clock += 1s;
    sample(2, 0, 0);
    assert(router.state(1) == State::ready);
    clock += 1s;
    sample(3, 10, 1);
    for (int i = 0; i < 3; ++i) { clock += 1s; sample(4 + i, 10, 1); }
    assert(router.state(1) == State::degraded);
    clock += 1s;
    sample(7, 11, 1);
    assert(router.state(1) == State::ready);

    Router queueRouter([](int, const std::string &) {}, [&] { return clock; });
    queueRouter.send(2, "oldest", 0);
    clock += 100ms;
    queueRouter.send(2, "newest", 0);
    clock += 150ms;
    const auto queueHealth = queueRouter.queueHealth();
    assert(queueHealth.size() == 1 && queueHealth[0].destination == 2 &&
           queueHealth[0].depth == 2 && queueHealth[0].oldestAgeMs == 250);

    Router gated([](int, const std::string &) {}, [&] { return clock; });
    Monitor gating([](int, Command) {}, [&](int id) { return gated.state(id); },
                   [&](int id, State state) { gated.setState(id, state); }, [&] { return clock; });
    gating.start(1);
    gating.observe(1, true);
    for (int i = 0; i < 3; ++i) { clock += 1s; gating.observe(1, false); gating.tick(); }
    assert(gated.state(1) == State::degraded);
    gated.send(1, "held", 0);
    gating.observe(1, true);
    assert(gated.queued(1) == 1);
    gating.report(1, {0, 0, 1, {}});
    gating.observe(1, false);
    gating.tick();
    assert(gated.state(1) == State::ready && gated.queued(1) == 0);

    std::cout << "outgoing router test passed\n";
    return 0;
}
