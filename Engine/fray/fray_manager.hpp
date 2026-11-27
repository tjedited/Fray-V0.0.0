#ifndef FRAY_MANAGER_HPP
#define FRAY_MANAGER_HPP

#include <atomic>
#include <algorithm>
#include <filesystem>
#include <functional>
#include <future>
#include <memory>
#include <mutex>
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
                std::unique_ptr<ProjectManager> project;
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
            std::unordered_map<std::string, Entry> _projects;
            std::vector<ProjectManager*> _openOrder;
            std::unordered_set<ProjectManager*> _closingProjects;
            struct PendingPrompt
            {
                PromptRequest request;
                std::function<void(const PromptResponse&)> callback;
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

            Entry* find(
                const std::string& name)
            {
                std::lock_guard<std::mutex> lock(_mutex);
                const auto found = _projects.find(name);
                return found == _projects.end() ? nullptr : &found->second;
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
                forgetProject(project);
                _openOrder.push_back(project);
            }

            void rekey(
                const std::string& oldName,
                const std::string& newName)
            {
                std::lock_guard<std::mutex> lock(_mutex);
                auto node = _projects.extract(oldName);
                if (node.empty())
                    return;
                if (_projects.count(newName) != 0)
                {
                    log::engineError("A project named %s is already registered; %s keeps its old name here.",
                                     newName.c_str(), oldName.c_str());
                    _projects.insert(std::move(node));
                    return;
                }
                node.key() = newName;
                _projects.insert(std::move(node));
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
                std::unordered_map<uint64_t, PendingPrompt> prompts;
                {
                    std::lock_guard<std::mutex> lock(_promptMutex);
                    if (closing)
                        _promptClosing = true;
                    prompts.swap(_pendingPrompts);
                }
                for (auto& entry : prompts)
                {
                    PromptResponse response;
                    response.set_request_id(entry.first);
                    response.set_dismissed(true);
                    response.set_error(reason);
                    if (!_applicationQueue->post([callback = std::move(entry.second.callback), response]
                        { callback(response); }))
                        log::engineError("Cannot report prompt cancellation: application thread is shutting down.");
                }
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
                std::function<void(const PromptResponse&)> callback);

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
                auto resolved = std::filesystem::weakly_canonical(path, error);
                if (error)
                {
                    log::engineError("Cannot resolve project path: %s", error.message().c_str());
                    if (completion) completion(errors::FAILED_OPEN_PROJECT);
                    return ready(errors::FAILED_OPEN_PROJECT);
                }
                if (resolved.filename().empty() && resolved != resolved.root_path())
                    resolved = resolved.parent_path();
                const std::string name = resolved.extension() == ".fry"
                    ? resolved.stem().string() : resolved.filename().string();
                Entry stale;
                bool alreadyOpen = false;
                {
                    std::lock_guard<std::mutex> lock(_mutex);
                    const auto found = _projects.find(name);
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
                }
                if (alreadyOpen)
                {
                    log::engineError("Project is already open: %s", name.c_str());
                    if (completion) completion(errors::PROJECT_ALREADY_OPEN);
                    return ready(errors::PROJECT_ALREADY_OPEN);
                }
                if (stale.queue)
                    retire(stale);

                Entry entry;
                entry.project = std::make_unique<ProjectManager>();
                entry.queue = std::make_shared<threads::TaskQueue>();
                ProjectManager* project = entry.project.get();
                std::shared_ptr<threads::TaskQueue> queue = entry.queue;
                project->beginOpening();
                project->setRenameCallback([this](const std::string& from, const std::string& to) { rekey(from, to); });
                entry.thread = _threads->spawn("project:" + name, [queue, project](threads::StopToken)
                {
                    queue->run([project] { return project->hasThreads(); });
                });
                {
                    std::lock_guard<std::mutex> lock(_mutex);
                    _projects.emplace(name, std::move(entry));
                }
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
                Entry* entry = find(name);
                return entry ? entry->project->databaseCandidates() : std::vector<std::string>();
            }

            F_err resolveDatabase(
                const std::string& name,
                const DatabaseChoice& choice)
            {
                Entry* entry = find(name);
                if (entry == nullptr)
                {
                    log::engineError("No project is waiting for a database choice: %s", name.c_str());
                    return errors::FAILED_OPEN_PROJECT;
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
                Entry* entry = find(name);
                if (entry == nullptr)
                {
                    log::engineError("No project is waiting for a database choice: %s", name.c_str());
                    return errors::FAILED_OPEN_PROJECT;
                }
                ProjectManager* project = entry->project.get();
                const F_err result = callOnThread(*entry, [project] { return project->cancelOpen(); },
                                                  errors::FAILED_OPEN_PROJECT);
                if (result != errors::NONE)
                    return result;
                Entry removed;
                {
                    std::lock_guard<std::mutex> lock(_mutex);
                    const auto found = _projects.find(name);
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
                const auto found = _projects.find(name);
                if (found == _projects.end() || !found->second.project->isOpen())
                    throw std::out_of_range("Project is not open: " + name);
                return *found->second.project;
            }

            // An empty target selects the most recently opened project. Completion runs on the project thread.
            void requestCloseProject(
                const std::string& target,
                bool package,
                std::function<void(const std::string&, F_err, bool)> completion)
            {
                std::unique_lock<std::mutex> lock(_mutex);
                _openOrder.erase(std::remove_if(_openOrder.begin(), _openOrder.end(),
                    [](ProjectManager* project) { return !project->isOpen(); }), _openOrder.end());
                ProjectManager* project = nullptr;
                std::shared_ptr<threads::TaskQueue> queue;
                if (target.empty())
                {
                    if (!_openOrder.empty())
                        project = _openOrder.back();
                }
                else
                {
                    const auto found = _projects.find(target);
                    if (found != _projects.end() && found->second.project->isOpen())
                        project = found->second.project.get();
                }
                if (project)
                    for (auto& entry : _projects)
                        if (entry.second.project.get() == project)
                            queue = entry.second.queue;
                if (!project || !queue)
                {
                    log::engineError("Cannot close project: no matching project is open.");
                    lock.unlock();
                    completion(target, errors::PROJECT_NOT_FOUND, false);
                    return;
                }
                if (!_closingProjects.insert(project).second)
                {
                    log::engineError("Cannot close project: it is already closing.");
                    lock.unlock();
                    completion(target, errors::FAILED_CLOSE_PROJECT, false);
                    return;
                }
                if (!queue->post([this, project, queue, package, completion]
                {
                    const std::string name = project->name();
                    bool packaged = false;
                    const F_err result = project->close(package, &packaged);
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

            F_err closeProject(
                const std::string& name)
            {
                Entry* entry = find(name);
                if (entry == nullptr)
                {
                    log::engineError("Cannot close project: project is not open: %s", name.c_str());
                    return errors::FAILED_CLOSE_PROJECT;
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
                    const auto found = _projects.find(name);
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
