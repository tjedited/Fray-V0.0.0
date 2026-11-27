#ifndef FRAY_THREAD_MANAGER_HPP
#define FRAY_THREAD_MANAGER_HPP

#include <atomic>
#include <chrono>
#include <condition_variable>
#include <cstdint>
#include <deque>
#include <exception>
#include <functional>
#include <future>
#include <map>
#include <memory>
#include <mutex>
#include <string>
#include <thread>
#include <utility>
#include <vector>

#include "log_manager.hpp"

namespace fray
{
    namespace threads
    {
        // Cooperative cancellation shared by every copy of a token.
        class StopToken
        {
            private:
                struct State
                {
                    std::mutex mutex;
                    std::condition_variable wake;
                    bool stop = false;
                };
                std::shared_ptr<State> _state = std::make_shared<State>();

            public:
                bool stopRequested() const
                {
                    std::lock_guard<std::mutex> lock(_state->mutex);
                    return _state->stop;
                }

                // Sleeps for up to `duration`; returns true as soon as a stop is requested.
                template<typename Rep, typename Period>
                bool waitFor(
                    const std::chrono::duration<Rep, Period>& duration) const
                {
                    std::unique_lock<std::mutex> lock(_state->mutex);
                    return _state->wake.wait_for(lock, duration, [this] { return _state->stop; });
                }

                void requestStop() const
                {
                    {
                        std::lock_guard<std::mutex> lock(_state->mutex);
                        _state->stop = true;
                    }
                    _state->wake.notify_all();
                }
        };

        // A task loop that runs on one thread. Other threads post work to it.
        class TaskQueue
        {
            private:
                std::mutex _mutex;
                std::condition_variable _wake;
                std::deque<std::function<void()>> _tasks;
                bool _shutdown = false;

            public:
                // Returns false (and drops the task) once the queue has been shut down.
                bool post(
                    std::function<void()> task)
                {
                    {
                        std::lock_guard<std::mutex> lock(_mutex);
                        if (_shutdown)
                            return false;
                        _tasks.push_back(std::move(task));
                    }
                    _wake.notify_one();
                    return true;
                }

                // If the queue is shut down the returned future reports a broken promise.
                template<typename Function>
                auto call(
                    Function function) -> std::future<decltype(function())>
                {
                    using Result = decltype(function());
                    auto task = std::make_shared<std::packaged_task<Result()>>(std::move(function));
                    auto future = task->get_future();
                    post([task] { (*task)(); });
                    return future;
                }

                void shutdown()
                {
                    {
                        std::lock_guard<std::mutex> lock(_mutex);
                        _shutdown = true;
                    }
                    _wake.notify_all();
                }

                // Runs queued tasks until shutdown() was called, the queue is empty and keepAlive() is false.
                void run(
                    const std::function<bool()>& keepAlive = nullptr)
                {
                    for (;;)
                    {
                        std::function<void()> task;
                        {
                            std::unique_lock<std::mutex> lock(_mutex);
                            const auto finished = [&] { return _shutdown && !(keepAlive && keepAlive()); };
                            _wake.wait_for(lock, std::chrono::milliseconds(50),
                                           [&] { return !_tasks.empty() || finished(); });
                            if (_tasks.empty())
                            {
                                if (finished())
                                    return;
                                continue;
                            }
                            task = std::move(_tasks.front());
                            _tasks.pop_front();
                        }
                        try
                        {
                            task();
                        }
                        catch (const std::exception& error)
                        {
                            fray::log::engineError("Thread task failed: %s", error.what());
                        }
                        catch (...)
                        {
                            fray::log::engineError("Thread task failed with an unknown exception.");
                        }
                    }
                }
        };

        class ThreadManager
        {
            public:
                using Id = std::uint64_t;

            private:
                struct Entry
                {
                    std::string name;
                    std::thread thread;
                    StopToken token;
                    std::shared_ptr<std::atomic<bool>> finished;
                };
                mutable std::mutex _mutex;
                std::map<Id, Entry> _entries;
                Id _next = 1;

            public:
                ThreadManager() = default;
                ThreadManager(
                    const ThreadManager&) = delete;
                ThreadManager& operator=(
                    const ThreadManager&) = delete;

                ~ThreadManager()
                {
                    const std::vector<std::string> remaining = runningNames();
                    if (!remaining.empty())
                    {
                        std::string names;
                        for (const std::string& name : remaining)
                            names += (names.empty() ? "" : ", ") + name;
                        fray::log::engineWarn("Waiting on %zu thread(s) to finish: %s", remaining.size(), names.c_str());
                    }
                    stopAll();
                    joinAll();
                }

                Id spawn(
                    const std::string& name,
                    std::function<void(StopToken)> body)
                {
                    StopToken token;
                    auto finished = std::make_shared<std::atomic<bool>>(false);
                    std::thread thread([name, body = std::move(body), token, finished]
                    {
                        try
                        {
                            body(token);
                        }
                        catch (const std::exception& error)
                        {
                            fray::log::engineError("Thread %s failed: %s", name.c_str(), error.what());
                        }
                        catch (...)
                        {
                            fray::log::engineError("Thread %s failed with an unknown exception.", name.c_str());
                        }
                        finished->store(true);
                    });
                    std::lock_guard<std::mutex> lock(_mutex);
                    const Id id = _next++;
                    _entries.emplace(id, Entry{name, std::move(thread), token, finished});
                    return id;
                }

                bool running(
                    Id id) const
                {
                    std::lock_guard<std::mutex> lock(_mutex);
                    const auto found = _entries.find(id);
                    return found != _entries.end() && !found->second.finished->load();
                }

                std::size_t running() const
                {
                    std::lock_guard<std::mutex> lock(_mutex);
                    std::size_t count = 0;
                    for (const auto& entry : _entries)
                        if (!entry.second.finished->load())
                            ++count;
                    return count;
                }

                // Names of the threads that are still running, to show what is holding up a shutdown.
                std::vector<std::string> runningNames() const
                {
                    std::lock_guard<std::mutex> lock(_mutex);
                    std::vector<std::string> names;
                    for (const auto& entry : _entries)
                        if (!entry.second.finished->load())
                            names.push_back(entry.second.name);
                    return names;
                }

                void requestStop(
                    Id id)
                {
                    std::lock_guard<std::mutex> lock(_mutex);
                    const auto found = _entries.find(id);
                    if (found != _entries.end())
                        found->second.token.requestStop();
                }

                // Blocks until the thread ends, then forgets it. Joining the calling thread is refused.
                bool join(
                    Id id)
                {
                    std::thread thread;
                    {
                        std::lock_guard<std::mutex> lock(_mutex);
                        const auto found = _entries.find(id);
                        if (found == _entries.end())
                            return true;
                        if (found->second.thread.get_id() == std::this_thread::get_id())
                            return false;
                        thread = std::move(found->second.thread);
                        _entries.erase(found);
                    }
                    if (thread.joinable())
                        thread.join();
                    return true;
                }

                void stopAll()
                {
                    std::lock_guard<std::mutex> lock(_mutex);
                    for (auto& entry : _entries)
                        entry.second.token.requestStop();
                }

                void joinAll()
                {
                    std::vector<Id> ids;
                    {
                        std::lock_guard<std::mutex> lock(_mutex);
                        for (const auto& entry : _entries)
                            ids.push_back(entry.first);
                    }
                    for (const Id id : ids)
                        join(id);
                }
        };
    }
}

#endif
