#ifndef FRAY_MANAGER_HPP
#define FRAY_MANAGER_HPP

#include <atomic>
#include <algorithm>
#include <filesystem>
#include <functional>
#include <future>
#include <memory>
#include <mutex>
#include <optional>
#include <stdexcept>
#include <string>
#include <unordered_map>
#include <unordered_set>
#include <vector>

#include "project_manager.hpp"
#include "thread_manager.hpp"
#include "fray.pb.h"

namespace fray
{
    namespace ipc { class IPCManager; }
    namespace message { struct InData; }

    // Owns the projects. Each project runs on its own thread, so several can load at once and a
    // slow one does not hold up the others. FrayManager's own methods are meant to be driven from
    // one controlling thread.
    class FrayManager
    {
        private:
            struct Entry
            {
                std::shared_ptr<ProjectManager> project;
                std::shared_ptr<threads::TaskQueue> queue;
                threads::ThreadManager::Id thread = 0;
            };

            inline static std::atomic<bool> _active{false};
            std::string _applicationId;
            std::unique_ptr<threads::ThreadManager> _ownedThreads;
            threads::ThreadManager* _threads;
            threads::ThreadManager::Id _applicationThread = 0;
            std::shared_ptr<threads::TaskQueue> _applicationQueue = std::make_shared<threads::TaskQueue>();
            bool _shutdown = false;
            std::mutex _mutex;
            using Projects = std::unordered_map<std::string, Entry>;
            Projects _projects;
            std::vector<ProjectManager*> _openOrder;
            std::unordered_set<ProjectManager*> _closingProjects;
            struct PendingPrompt
            {
                PromptRequest request;
                PromptResponse response;
                bool completed = false;
            };
            std::mutex _promptMutex;
            std::unordered_map<uint64_t, PendingPrompt> _pendingPrompts;
            bool _promptClosing = false;

            static std::future<F_err> ready(
                F_err result)
            {
                std::promise<F_err> promise;
                promise.set_value(result);
                return promise.get_future();
            }

            // Runs on the project's thread and waits; a queue that already shut down counts as failure.
            template<typename Function>
            static F_err callOnThread(
                Entry& entry,
                Function function,
                F_err failure)
            {
                try
                {
                    return entry.queue->call(std::move(function)).get();
                }
                catch (const std::future_error&)
                {
                    log::engineError("The project's thread is no longer running.");
                    return failure;
                }
            }

            static std::string projectKey(
                const std::string& path,
                std::error_code& error)
            {
                if (path.empty() || path.find('\0') != std::string::npos)
                {
                    error = std::make_error_code(std::errc::invalid_argument);
                    return {};
                }
                auto resolved = std::filesystem::weakly_canonical(path, error);
                if (error)
                    return {};
                if (resolved.filename().empty() && resolved != resolved.root_path())
                    resolved = resolved.parent_path();
                if (resolved.extension() == ".fry")
                    resolved.replace_extension();
                return resolved.string();
            }

            // Caller holds _mutex. A bare name is accepted only when exactly one active project matches.
            Projects::iterator lookup(
                const std::string& target,
                F_err& error,
                bool includeClosed = false)
            {
                error = errors::PROJECT_NOT_FOUND;
                const std::filesystem::path input(target);
                if (input.is_absolute() || input.has_parent_path())
                {
                    std::error_code pathError;
                    const std::string key = projectKey(target, pathError);
                    if (pathError)
                    {
                        log::engineError("Cannot resolve project path: %s", pathError.message().c_str());
                        return _projects.end();
                    }
                    auto found = _projects.find(key);
                    if (found != _projects.end() &&
                        (includeClosed || found->second.project->isOpen() || found->second.project->isOpening()))
                    {
                        error = errors::NONE;
                        return found;
                    }
                    return _projects.end();
                }
                auto match = _projects.end();
                for (auto it = _projects.begin(); it != _projects.end(); ++it)
                {
                    if (std::filesystem::path(it->first).filename() != input ||
                        (!includeClosed && !it->second.project->isOpen() && !it->second.project->isOpening()))
                        continue;
                    if (match != _projects.end())
                    {
                        error = errors::PROJECT_AMBIGUOUS;
                        log::engineError("Multiple projects are named %s; use the full path.", target.c_str());
                        return _projects.end();
                    }
                    match = it;
                }
                if (match != _projects.end())
                    error = errors::NONE;
                return match;
            }

            std::optional<Entry> find(
                const std::string& name,
                F_err& error,
                bool includeClosed = false)
            {
                std::lock_guard<std::mutex> lock(_mutex);
                const auto found = lookup(name, error, includeClosed);
                return found == _projects.end() ? std::nullopt : std::optional<Entry>(found->second);
            }

            void retire(
                Entry& entry)
            {
                entry.queue->shutdown();
                _threads->join(entry.thread);
            }

            void forgetProject(
                ProjectManager* project)
            {
                _openOrder.erase(std::remove(_openOrder.begin(), _openOrder.end(), project), _openOrder.end());
            }

            void recordOpen(
                ProjectManager* project)
            {
                std::lock_guard<std::mutex> lock(_mutex);
                const auto found = std::find_if(_projects.begin(), _projects.end(),
                    [project](const auto& entry) { return entry.second.project.get() == project; });
                if (found == _projects.end() || !project->isOpen())
                    return;
                forgetProject(project);
                _openOrder.push_back(project);
            }

            void rekey(
                ProjectManager* project,
                const std::filesystem::path& path)
            {
                std::error_code error;
                const std::string key = projectKey(path.string(), error);
                if (error)
                {
                    log::engineError("Cannot update renamed project path: %s", error.message().c_str());
                    return;
                }
                Entry stale;
                {
                    std::lock_guard<std::mutex> lock(_mutex);
                    auto found = std::find_if(_projects.begin(), _projects.end(),
                        [project](const auto& entry) { return entry.second.project.get() == project; });
                    if (found == _projects.end() || found->first == key)
                        return;
                    const auto collision = _projects.find(key);
                    if (collision != _projects.end())
                    {
                        if (collision->second.project->isOpen() || collision->second.project->isOpening())
                        {
                            log::engineError("Cannot register renamed project: %s is already open.", key.c_str());
                            return;
                        }
                        stale = std::move(collision->second);
                        _projects.erase(collision);
                    }
                    auto node = _projects.extract(found);
                    node.key() = key;
                    _projects.insert(std::move(node));
                }
                if (stale.queue)
                    retire(stale);
            }

            void init()
            {
                bool expected = false;
                if (!_active.compare_exchange_strong(expected, true))
                    throw std::logic_error("Only one FrayManager may exist in an engine process.");
                // Runs application-level work so it never waits on a project or on message routing.
                _applicationThread = _threads->spawn("application", [queue = _applicationQueue](threads::StopToken)
                                                     { queue->run(); });
            }

        public:
            // Uses its own ThreadManager, which is convenient for tests.
            explicit FrayManager(
                const std::string& applicationId = "Fray")
                : _applicationId(applicationId),
                  _ownedThreads(std::make_unique<threads::ThreadManager>()),
                  _threads(_ownedThreads.get())
            {
                init();
            }

            // Registers its threads with a ThreadManager owned by someone else, which must outlive this object.
            explicit FrayManager(
                threads::ThreadManager& threads,
                const std::string& applicationId = "Fray")
                : _applicationId(applicationId), _threads(&threads)
            {
                init();
            }
            FrayManager(
                const FrayManager&) = delete;
            FrayManager& operator=(
                const FrayManager&) = delete;

            ~FrayManager()
            {
                shutdown();
                _active = false;
            }

            // Stop accepting application tasks and finish project work before IPC is destroyed.
            void shutdown()
            {
                if (_shutdown)
                    return;
                cancelPrompts("Application is shutting down.", true);
                _applicationQueue->shutdown();
                _threads->join(_applicationThread);
                _shutdown = true;
                std::vector<std::future<void>> openings;
                {
                    std::lock_guard<std::mutex> lock(_mutex);
                    for (auto& entry : _projects)
                        if (entry.second.project->isOpening() || _closingProjects.count(entry.second.project.get()))
                            openings.push_back(entry.second.queue->call([] {}));
                }
                for (auto& opening : openings)
                {
                    try { opening.get(); }
                    catch (const std::future_error&)
                    {
                        log::engineWarn("Project queue stopped before its shutdown barrier; the open may have failed.");
                    }
                }
                if (close() != errors::NONE)
                    log::engineError("Some projects could not be closed; check their archives and working folders.");
                for (auto& entry : _projects)
                    entry.second.queue->shutdown();
                // Only this manager's own threads; the shared ThreadManager may hold others.
                for (auto& entry : _projects)
                    _threads->join(entry.second.thread);
                _projects.clear();
                _openOrder.clear();
                _closingProjects.clear();
            }

            void cancelPrompts(
                const std::string& reason,
                bool closing = false)
            {
                std::lock_guard<std::mutex> lock(_promptMutex);
                if (closing)
                    _promptClosing = true;
                for (auto& entry : _pendingPrompts)
                {
                    if (entry.second.completed)
                        continue;
                    entry.second.response.set_request_id(entry.first);
                    entry.second.response.set_dismissed(true);
                    entry.second.response.set_error(reason);
                    entry.second.completed = true;
                }
            }

            bool takePromptResponse(
                uint64_t requestId,
                PromptResponse& response)
            {
                std::lock_guard<std::mutex> lock(_promptMutex);
                const auto found = _pendingPrompts.find(requestId);
                if (found == _pendingPrompts.end() || !found->second.completed)
                    return false;
                response = std::move(found->second.response);
                _pendingPrompts.erase(found);
                return true;
            }

            const std::string& applicationId() const { return _applicationId; }

            // Queues work for the application thread. Returns false once the manager is shutting down.
            bool postApplication(
                std::function<void()> task) { return _applicationQueue->post(std::move(task)); }

            // Called by the engine message thread; project work is dispatched asynchronously.
            void handleApplicationMessage(
                const message::InData& incoming,
                ipc::IPCManager& ipc);

            bool requestPrompt(
                ipc::IPCManager& ipc,
                const PromptRequest& request,
                uint64_t& requestId);

            // Starts opening a project on its own thread. The optional completion runs on that thread,
            // or on the caller for an immediate failure. Conflict cancellation is opt-in for callers
            // that cannot resolve a pending database choice.
            std::future<F_err> openProject(
                const std::string& path,
                files::ConflictChoice choice = files::ConflictChoice::Ask,
                std::function<void(F_err)> completion = {},
                bool cancelOnDatabaseConflict = false,
                files::OpenMode mode = files::OpenMode::OpenOrCreate)
            {
                if (_shutdown)
                {
                    log::engineError("Cannot open project: FrayManager is shut down.");
                    if (completion) completion(errors::FAILED_OPEN_PROJECT);
                    return ready(errors::FAILED_OPEN_PROJECT);
                }
                if (path.empty())
                {
                    log::engineError("Cannot open project: path is empty.");
                    if (completion) completion(errors::FAILED_OPEN_PROJECT);
                    return ready(errors::FAILED_OPEN_PROJECT);
                }
                std::error_code error;
                const std::string key = projectKey(path, error);
                if (error)
                {
                    log::engineError("Cannot resolve project path: %s", error.message().c_str());
                    if (completion) completion(errors::FAILED_OPEN_PROJECT);
                    return ready(errors::FAILED_OPEN_PROJECT);
                }
                Entry stale;
                bool alreadyOpen = false;
                ProjectManager* project = nullptr;
                std::shared_ptr<threads::TaskQueue> queue;
                {
                    std::lock_guard<std::mutex> lock(_mutex);
                    const auto found = _projects.find(key);
                    if (found != _projects.end())
                    {
                        if (found->second.project->isOpen() || found->second.project->isOpening())
                            alreadyOpen = true;
                        else
                        {
                            forgetProject(found->second.project.get());
                            stale = std::move(found->second);
                            _projects.erase(found);
                        }
                    }
                    if (!alreadyOpen)
                    {
                        Entry entry;
                        entry.project = std::make_shared<ProjectManager>();
                        entry.queue = std::make_shared<threads::TaskQueue>();
                        project = entry.project.get();
                        queue = entry.queue;
                        project->beginOpening();
                        project->setRenameCallback([this, project](const std::filesystem::path& renamed)
                                                   { rekey(project, renamed); });
                        entry.thread = _threads->spawn("project:" + key, [queue, project](threads::StopToken)
                        {
                            queue->run([project] { return project->hasThreads(); });
                        });
                        _projects.emplace(key, std::move(entry));
                    }
                }
                if (alreadyOpen)
                {
                    log::engineError("Project is already open: %s", key.c_str());
                    if (completion) completion(errors::PROJECT_ALREADY_OPEN);
                    return ready(errors::PROJECT_ALREADY_OPEN);
                }
                if (stale.queue)
                    retire(stale);

                return queue->call([this, project, queue, path, choice, completion = std::move(completion),
                                    cancelOnDatabaseConflict, mode]
                {
                    const F_err result = project->open(path, _applicationId, choice, _threads, queue, mode);
                    if (result == errors::NONE)
                        recordOpen(project);
                    if (result == errors::DATABASE_CONFLICT && cancelOnDatabaseConflict)
                    {
                        if (project->cancelOpen() != errors::NONE)
                            log::engineError("Could not cancel the pending database choice.");
                        else
                            queue->shutdown();
                    }
                    if (result != errors::NONE && result != errors::DATABASE_CONFLICT)
                        queue->shutdown();
                    if (completion) completion(result);
                    return result;
                });
            }

            // After DATABASE_CONFLICT: the files that could be the project's database.
            std::vector<std::string> databaseCandidates(
                const std::string& name)
            {
                F_err error;
                auto entry = find(name, error);
                if (!entry && error == errors::PROJECT_NOT_FOUND)
                    log::engineError("No project is waiting for a database choice: %s", name.c_str());
                return entry ? entry->project->databaseCandidates() : std::vector<std::string>();
            }

            F_err resolveDatabase(
                const std::string& name,
                const DatabaseChoice& choice)
            {
                F_err lookupError;
                auto entry = find(name, lookupError);
                if (!entry)
                {
                    log::engineError("No project is waiting for a database choice: %s", name.c_str());
                    return lookupError == errors::PROJECT_AMBIGUOUS ? lookupError : errors::FAILED_OPEN_PROJECT;
                }
                ProjectManager* project = entry->project.get();
                const F_err result = callOnThread(*entry, [project, choice] { return project->resolveDatabase(choice); },
                                                  errors::FAILED_OPEN_PROJECT);
                if (result == errors::NONE)
                    recordOpen(project);
                if (result != errors::NONE && !project->isOpen() && project->databaseCandidates().empty())
                    entry->queue->shutdown();
                return result;
            }

            F_err cancelProject(
                const std::string& name)
            {
                F_err lookupError;
                auto entry = find(name, lookupError);
                if (!entry)
                {
                    log::engineError("No project is waiting for a database choice: %s", name.c_str());
                    return lookupError == errors::PROJECT_AMBIGUOUS ? lookupError : errors::FAILED_OPEN_PROJECT;
                }
                ProjectManager* project = entry->project.get();
                const F_err result = callOnThread(*entry, [project] { return project->cancelOpen(); },
                                                  errors::FAILED_OPEN_PROJECT);
                if (result != errors::NONE)
                    return result;
                Entry removed;
                {
                    std::lock_guard<std::mutex> lock(_mutex);
                    const auto found = std::find_if(_projects.begin(), _projects.end(),
                        [project](const auto& item) { return item.second.project.get() == project; });
                    if (found == _projects.end())
                    {
                        log::engineError("Cannot remove project: it is no longer registered.");
                        return errors::FAILED_OPEN_PROJECT;
                    }
                    forgetProject(found->second.project.get());
                    removed = std::move(found->second);
                    _projects.erase(found);
                }
                retire(removed);
                return errors::NONE;
            }

            ProjectManager& project(
                const std::string& name)
            {
                std::lock_guard<std::mutex> lock(_mutex);
                F_err error;
                const auto found = lookup(name, error);
                if (error == errors::PROJECT_AMBIGUOUS)
                    throw std::invalid_argument("Multiple projects have this name; use the full path: " + name);
                if (found == _projects.end() || !found->second.project->isOpen())
                    throw std::out_of_range("Project is not open: " + name);
                return *found->second.project;
            }

        private:
            // An empty target selects the most recently opened project. Completion runs on the project thread.
            void queueProjectClose(
                const std::string& target,
                std::function<F_err(ProjectManager&, bool&)> operation,
                std::function<void(const std::string&, F_err, bool)> completion)
            {
                std::unique_lock<std::mutex> lock(_mutex);
                _openOrder.erase(std::remove_if(_openOrder.begin(), _openOrder.end(),
                    [](ProjectManager* project) { return !project->isOpen(); }), _openOrder.end());
                ProjectManager* project = nullptr;
                std::shared_ptr<threads::TaskQueue> queue;
                F_err lookupError = errors::PROJECT_NOT_FOUND;
                if (target.empty())
                {
                    if (!_openOrder.empty())
                        project = _openOrder.back();
                }
                else
                {
                    const auto found = lookup(target, lookupError);
                    if (found != _projects.end() && found->second.project->isOpen())
                        project = found->second.project.get();
                    else if (lookupError == errors::NONE)
                        lookupError = errors::PROJECT_NOT_FOUND;
                }
                if (project)
                    for (auto& entry : _projects)
                        if (entry.second.project.get() == project)
                            queue = entry.second.queue;
                if (!project || !queue)
                {
                    log::engineError("Cannot close project: %s",
                                     lookupError == errors::PROJECT_AMBIGUOUS
                                         ? "multiple projects have this name; use the full path."
                                         : "no matching project is open.");
                    lock.unlock();
                    completion(target, lookupError, false);
                    return;
                }
                if (!_closingProjects.insert(project).second)
                {
                    log::engineError("Cannot close project: it is already closing.");
                    lock.unlock();
                    completion(target, errors::FAILED_CLOSE_PROJECT, false);
                    return;
                }
                if (!queue->post([this, project, queue, operation = std::move(operation), completion]
                {
                    const std::string name = project->name();
                    bool packaged = false;
                    const F_err result = operation(*project, packaged);
                    {
                        std::lock_guard<std::mutex> lock(_mutex);
                        _closingProjects.erase(project);
                        if (result == errors::NONE)
                        {
                            forgetProject(project);
                            queue->shutdown();
                        }
                    }
                    completion(name, result, packaged);
                }))
                {
                    _closingProjects.erase(project);
                    log::engineError("Cannot close project: its queue is stopped.");
                    lock.unlock();
                    completion(target, errors::FAILED_CLOSE_PROJECT, false);
                }
            }

            void handleProjectMessage(
                const message::InData& incoming,
                ipc::IPCManager& ipc);

        public:
            void requestCloseProject(
                const std::string& target,
                bool package,
                std::function<void(const std::string&, F_err, bool)> completion)
            {
                queueProjectClose(target, [package](ProjectManager& project, bool& packaged)
                {
                    return project.close(package, &packaged);
                }, std::move(completion));
            }

            F_err closeProject(
                const std::string& name)
            {
                F_err lookupError;
                auto entry = find(name, lookupError);
                if (!entry && lookupError == errors::PROJECT_NOT_FOUND)
                    entry = find(name, lookupError, true);
                if (!entry)
                {
                    log::engineError("Cannot close project: project is not open: %s", name.c_str());
                    return lookupError == errors::PROJECT_AMBIGUOUS ? lookupError : errors::FAILED_CLOSE_PROJECT;
                }
                ProjectManager* project = entry->project.get();
                if (project->isOpen())
                {
                    const F_err result = callOnThread(*entry, [project] { return project->close(); },
                                                      errors::FAILED_CLOSE_PROJECT);
                    if (result != errors::NONE)
                        return result;
                }
                Entry removed;
                {
                    std::lock_guard<std::mutex> lock(_mutex);
                    const auto found = std::find_if(_projects.begin(), _projects.end(),
                        [project](const auto& item) { return item.second.project.get() == project; });
                    if (found == _projects.end())
                    {
                        log::engineError("Cannot remove project: it is no longer registered.");
                        return errors::FAILED_CLOSE_PROJECT;
                    }
                    forgetProject(found->second.project.get());
                    removed = std::move(found->second);
                    _projects.erase(found);
                }
                retire(removed);
                return errors::NONE;
            }

            // Closes every open project, all at once on their own threads.
            F_err close()
            {
                std::vector<std::future<F_err>> pending;
                {
                    std::lock_guard<std::mutex> lock(_mutex);
                    for (auto& entry : _projects)
                        if (entry.second.project->isOpen())
                        {
                            ProjectManager* project = entry.second.project.get();
                            pending.push_back(entry.second.queue->call([project] { return project->close(); }));
                        }
                }
                F_err result = errors::NONE;
                for (auto& future : pending)
                {
                    try
                    {
                        if (future.get() != errors::NONE)
                            result = errors::FAILED_CLOSE_PROJECT;
                    }
                    catch (const std::future_error&)
                    {
                        result = errors::FAILED_CLOSE_PROJECT;
                    }
                }
                return result;
            }
    };
}

#endif
