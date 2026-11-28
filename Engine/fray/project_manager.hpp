#ifndef FRAY_PROJECT_MANAGER_HPP
#define FRAY_PROJECT_MANAGER_HPP

#include <algorithm>
#include <atomic>
#include <filesystem>
#include <functional>
#include <memory>
#include <mutex>
#include <stdexcept>
#include <string>
#include <type_traits>
#include <unordered_map>
#include <vector>

#include "file_manager.hpp"
#include "file_watcher.hpp"
#include "state_manager.hpp"
#include "thread_manager.hpp"

namespace fray
{
    class ProjectCloseRequest;

    // How to settle several candidate database files when none is named after the project.
    struct DatabaseChoice
    {
        bool createNew = false;
        std::string name;   // Candidate to adopt (file name without ".sqlite").

        static DatabaseChoice use(
            const std::string& candidate) { return {false, candidate}; }
        static DatabaseChoice create() { return {true, ""}; }
    };

    // Every public method is safe to call from any thread. Opening, closing and file-change handling
    // are meant to run on the project's own thread (see FrayManager); StateManager references handed
    // out by state() are individually thread-safe as well.
    class ProjectManager
    {
        public:
            static bool validProjectName(
                const std::string& name)
            {
                return files::FileManager::safeRelative(name) && name.find('/') == std::string::npos &&
                       name != "." && name != ".." &&
                       !(name.size() >= 4 && name.compare(name.size() - 4, 4, ".fry") == 0);
            }

        private:
            mutable std::recursive_mutex _mutex;
            files::FileManager _files;
            std::unordered_map<std::string, std::unique_ptr<state::StateManager>> _states;
            std::string _applicationId;
            std::atomic<bool> _open{false};
            std::atomic<bool> _opening{false};
            bool _closing = false;
            bool _packageOnClose = false;
            bool _archiveComplete = false;
            bool _pendingDatabase = false;
            std::vector<std::string> _candidates;

            watch::FileWatcher _watcher;
            watch::FileId _databaseId;
            watch::FileWatcher::Subscription _subscription = 0;
            threads::ThreadManager* _threads = nullptr;
            std::shared_ptr<threads::TaskQueue> _queue;
            mutable std::mutex _threadMutex;
            std::vector<threads::ThreadManager::Id> _registered;
            threads::ThreadManager::Id _watcherThread = 0;
            std::function<void(const std::filesystem::path&)> _onRenamed;

            // Only the current "fray_state_<hex of Fray>" table (key, type, value) counts as a Fray database.
            static bool looksLikeFrayDatabase(
                const std::filesystem::path& path)
            {
                sqlite3* db = nullptr;
                const std::string file = path.string();
                if (sqlite3_open_v2(file.c_str(), &db, SQLITE_OPEN_READONLY, nullptr) != SQLITE_OK)
                {
                    if (db != nullptr)
                        sqlite3_close(db);
                    return false;
                }
                sqlite3_stmt* statement = nullptr;
                const bool valid = sqlite3_prepare_v2(db, "SELECT key, type, value FROM fray_state_46726179 LIMIT 0",
                                                      -1, &statement, nullptr) == SQLITE_OK;
                sqlite3_finalize(statement);
                sqlite3_close(db);
                return valid;
            }

            static std::vector<std::string> databaseFiles(
                const std::filesystem::path& folder)
            {
                std::vector<std::string> stems;
                std::error_code error;
                std::filesystem::directory_iterator it(folder, error), end;
                for (; !error && it != end; it.increment(error))
                {
                    std::error_code entryError;
                    if (it->is_symlink(entryError) || !it->is_regular_file(entryError))
                        continue;
                    const auto& path = it->path();
                    if (path.extension() == ".sqlite" && !path.stem().empty())
                        stems.push_back(path.stem().string());
                }
                std::sort(stems.begin(), stems.end());
                return stems;
            }

            // Finds which database file belongs to this project, even if it was renamed.
            std::string locateDatabase(
                const std::filesystem::path& folder) const
            {
                watch::FileId id;
                const std::string current = _files.projectName();
                if (watch::fileId(folder / (current + ".sqlite"), id) && (!_databaseId.valid() || id == _databaseId))
                    return current;
                for (const auto& stem : databaseFiles(folder))
                    if (watch::fileId(folder / (stem + ".sqlite"), id) && id == _databaseId)
                        return stem;
                return "";
            }

            // Picks the database before any state is opened; may ask the caller to choose.
            F_err prepareDatabase()
            {
                const auto folder = _files.workingDirectory();
                const std::string name = _files.projectName();
                bool exists = false;
                if (!files::FileManager::pathExists(folder / (name + ".sqlite"), exists))
                    return errors::FAILED_OPEN_PROJECT;
                if (exists)
                    return _files.snapshotDatabase(name) ? errors::NONE : errors::FAILED_OPEN_PROJECT;
                std::vector<std::string> likely;
                for (const auto& stem : databaseFiles(folder))
                    if (looksLikeFrayDatabase(folder / (stem + ".sqlite")))
                        likely.push_back(stem);
                if (likely.empty())
                    return errors::NONE;
                if (likely.size() == 1)
                    return _files.snapshotDatabase(likely.front()) &&
                           files::FileManager::renameFolderDatabase(folder, likely.front(), name)
                        ? errors::NONE : errors::FAILED_OPEN_PROJECT;
                _candidates = std::move(likely);
                _pendingDatabase = true;
                return errors::DATABASE_CONFLICT;
            }

            void abandon(
                bool removeExtracted)
            {
                if (removeExtracted && _files._extracted && _files.removeWorkingDirectory() != errors::NONE)
                    log::engineError("Could not remove the extracted working folder.");
                if (!_files.rollbackConflict())
                    log::engineError("Could not restore the unselected project after opening failed.");
                if (_files.close() != errors::NONE)
                    log::engineError("Could not release project after opening failed.");
                _applicationId.clear();
                _candidates.clear();
                _pendingDatabase = false;
                _opening = false;
            }

            // Writes each default setting that the database does not have yet, so settings added in a
            // newer build appear in existing projects. Runs on the thread that opens the project.
            template<typename T>
            static F_err setDefault(
                state::StateManager& state,
                const std::string& key,
                const T& value)
            {
                F_bool exists = false;
                const F_err result = state.contains(key, exists);
                if (result != errors::NONE || exists)
                    return result;
                return state.set(key, value);
            }

            F_err applyDefaults(
                state::StateManager& state)
            {
                F_err result = errors::NONE;
                const auto apply = [&](const std::string& key, const auto& value)
                {
                    if (result == errors::NONE)
                        result = setDefault(state, key, value);
                };

                /* Application Info */
                apply("application.info.name", _applicationId);
                apply("application.info.engineVersion.major", 0);
                apply("application.info.engineVersion.minor", 0);
                apply("application.info.engineVersion.bug", 0);
                apply("application.info.uiVersion.major", 0);
                apply("application.info.uiVersion.minor", 0);
                apply("application.info.uiVersion.bug", 0);

                /* Project Info */
                apply("project.info.projectVersion.major", 0);
                apply("project.info.projectVersion.minor", 0);
                apply("project.info.projectVersion.bug", 0);

                /* Project Preferences */
                apply("project.preferences.packageOnClose", false);
                return result;
            }

            F_err finishOpen()
            {
                const bool snapshot = _files._extracted;
                auto state = std::make_unique<state::StateManager>();
                F_err result = state->open(_files, "Fray", _applicationId);
                if (result == errors::NONE)
                {
                    // The file name is the source of truth for the project name.
                    F_bool exists = false;
                    std::string stored;
                    result = state->contains("project.info.name", exists);
                    if (result == errors::NONE && exists)
                        result = state->get("project.info.name", stored);
                    if (result == errors::NONE && (!exists || stored != _files.projectName()))
                        result = state->set("project.info.name", _files.projectName());
                    if (result == errors::NONE)
                        result = applyDefaults(*state);
                }
                if (result != errors::NONE)
                {
                    state.reset();
                    abandon(false);
                    return result;
                }
                if (!_files.commitConflict())
                {
                    state.reset();
                    abandon(false);
                    return errors::FAILED_OPEN_PROJECT;
                }
                _states.emplace("Fray", std::move(state));
                if (snapshot)
                    _files.removeArchive();
                watch::fileId(_files.workingDirectory() / (_files.projectName() + ".sqlite"), _databaseId);
                _open = true;
                _opening = false;
                startWatching();
                return errors::NONE;
            }

            void startWatching()
            {
                if (!_watcher.watch(_files.workingDirectory()))
                {
                    log::engineError("Cannot watch the project folder.");
                    return;
                }
                _subscription = _watcher.subscribe(nullptr, [this](const watch::Change& change) { onChange(change); });
                if (_threads == nullptr)
                    return;
                std::weak_ptr<threads::TaskQueue> queue = _queue;
                _watcher.setNotify([this, queue]
                {
                    if (auto target = queue.lock())
                        target->post([this] { pump(); });
                });
                _watcherThread = registerThread("file-watcher", [this, queue](threads::StopToken token)
                {
                    _watcher.run(token, [this, queue]
                    {
                        if (auto target = queue.lock())
                            target->post([this] { restoreLock(); });
                    });
                });
            }

            void stopWatching()
            {
                if (_watcherThread != 0)
                {
                    stopThread(_watcherThread);
                    _watcherThread = 0;
                }
                _watcher.setNotify(nullptr);
                if (_subscription != 0)
                {
                    _watcher.unsubscribe(_subscription);
                    _subscription = 0;
                }
                _watcher.unwatch();
            }

            void onChange(
                const watch::Change& change)
            {
                std::lock_guard<std::recursive_mutex> lock(_mutex);
                if (!_open || _closing)
                    return;
                if (change.root)
                {
                    if (change.kind == watch::ChangeKind::Removed)
                        log::engineError("The project folder was removed or moved: %s", change.previousPath.string().c_str());
                    else if (change.kind == watch::ChangeKind::Renamed &&
                             change.previousPath == _files.workingDirectory() &&
                             change.path.filename().string() != _files.projectName())
                    {
                        const std::string name = change.path.filename().string();
                        log::engineInfo("Project folder was renamed to %s.", name.c_str());
                        if (applyName(name, change.path, false, "") != errors::NONE)
                            log::engineError("Could not rename the project to match its folder.");
                    }
                    return;
                }
                if (change.kind != watch::ChangeKind::Renamed || change.directory || change.id != _databaseId ||
                    change.relative.find('/') != std::string::npos ||
                    std::filesystem::path(change.relative).extension() != ".sqlite")
                    return;
                const std::string stem = std::filesystem::path(change.relative).stem().string();
                watch::FileId current;
                if (stem == _files.projectName() ||
                    !watch::fileId(_files.workingDirectory() / change.relative, current) || current != _databaseId)
                    return;
                log::engineInfo("Project database was renamed to %s.sqlite.", stem.c_str());
                if (applyName(stem, _files.workingDirectory(), true, stem) != errors::NONE)
                    log::engineError("Could not rename the project to match its database.");
            }

            // Renames the project: folder, database files, lock, archive and project.info.name together.
            // `workspace` is where the folder is now. With renameFolder false the folder was already
            // renamed (by the user) and only the rest follows; otherwise Fray renames the folder too.
            F_err applyName(
                const std::string& newName,
                const std::filesystem::path& workspace,
                bool renameFolder,
                std::string databaseStem)
            {
                using Files = files::FileManager;
                const std::string oldName = _files.projectName();
                if (!validProjectName(newName))
                {
                    log::engineError("Cannot rename project: invalid name.");
                    return errors::FAILED_RENAME_PROJECT;
                }
                _files._workspace = workspace;
                const auto parent = workspace.parent_path();
                const auto target = parent / newName;
                bool exists = false;
                if (renameFolder && (!Files::pathExists(target, exists) || exists))
                {
                    log::engineError("Cannot rename project: %s already exists.", target.string().c_str());
                    return errors::FAILED_RENAME_PROJECT;
                }
                if (databaseStem.empty())
                    databaseStem = locateDatabase(workspace);
                if (databaseStem.empty())
                {
                    log::engineError("Cannot rename project: its database file could not be found.");
                    return errors::FAILED_RENAME_PROJECT;
                }
                if (databaseStem != newName &&
                    (!Files::pathExists(workspace / (newName + ".sqlite"), exists) || exists))
                {
                    log::engineError("Cannot rename project: %s.sqlite already exists.", newName.c_str());
                    return errors::FAILED_RENAME_PROJECT;
                }
                Files::ProjectLock newLock;
                if (!_files.acquireRename(newName, newLock))
                    return errors::FAILED_RENAME_PROJECT;

                std::vector<std::unique_lock<std::recursive_mutex>> locks;
                std::vector<std::pair<std::string, state::StateManager*>> open;
                for (auto& entry : _states)
                {
                    locks.emplace_back(entry.second->mutex());
                    if (entry.second->isOpen())
                        open.emplace_back(entry.first, entry.second.get());
                }
                auto hold = _watcher.hold();
                const auto reopen = [&]
                {
                    bool ok = true;
                    for (auto& state : open)
                        if (!state.second->isOpen() && state.second->open(_files, state.first, _applicationId) != errors::NONE)
                            ok = false;
                    return ok;
                };
                // SQLite remembers file names (journal paths), so no connection stays open across a rename.
                for (auto& state : open)
                    if (state.second->close() != errors::NONE)
                    {
                        reopen();
                        Files::unlockProject(newLock);
                        return errors::FAILED_RENAME_PROJECT;
                    }

                const auto oldArchive = _files._archive;
                const auto newArchive = parent / (newName + ".fry");
                auto current = workspace;
                bool archiveMoved = false, folderMoved = false, databaseMoved = false;
                bool ok = true;
                if (_files._archiveExists)
                    archiveMoved = ok = Files::renameExclusive(oldArchive, newArchive);
                if (ok && renameFolder)
                {
                    folderMoved = ok = Files::renameExclusive(workspace, target);
                    if (ok)
                        current = target;
                }
                if (ok && databaseStem != newName)
                    databaseMoved = ok = Files::renameFolderDatabase(current, databaseStem, newName);
                if (!ok)
                {
                    if (databaseMoved && !Files::renameFolderDatabase(current, newName, databaseStem))
                        log::engineError("Could not restore the project database name.");
                    if (folderMoved && !Files::renameExclusive(target, workspace))
                        log::engineError("Could not restore the project folder name.");
                    if (archiveMoved && !Files::renameExclusive(newArchive, oldArchive))
                        log::engineError("Could not restore the project archive name.");
                    if (databaseStem != oldName && !Files::renameFolderDatabase(workspace, databaseStem, oldName))
                        log::engineError("Could not restore the project database name.");
                    Files::unlockProject(newLock);
                    reopen();
                    return errors::FAILED_RENAME_PROJECT;
                }

                _files.commitRename(newName, current, newLock);
                F_err result = reopen() ? errors::NONE : errors::FAILED_RENAME_PROJECT;
                if (result == errors::NONE)
                    result = _states.at("Fray")->set("project.info.name", newName);
                watch::fileId(current / (newName + ".sqlite"), _databaseId);
                _watcher.watch(current);
                log::engineInfo("Project renamed from %s to %s.", oldName.c_str(), newName.c_str());
                if (_onRenamed)
                    _onRenamed(current);
                return result;
            }

        public:
            ProjectManager() = default;
            ProjectManager(
                const ProjectManager&) = delete;
            ProjectManager& operator=(
                const ProjectManager&) = delete;

            ~ProjectManager()
            {
                if (_open && close() != errors::NONE)
                    log::engineError("Project could not be closed; check its archive and working folder.");
                else if (_pendingDatabase)
                    cancelOpen();
            }

            F_err open(
                const std::string& path,
                const std::string& applicationId,
                files::ConflictChoice choice = files::ConflictChoice::Ask,
                threads::ThreadManager* threads = nullptr,
                std::shared_ptr<threads::TaskQueue> queue = nullptr,
                files::OpenMode mode = files::OpenMode::OpenOrCreate)
            {
                std::lock_guard<std::recursive_mutex> lock(_mutex);
                if (_open || _files.isOpen() || _pendingDatabase)
                {
                    log::engineError("Cannot open project: manager already has a project.");
                    return errors::FAILED_OPEN_PROJECT;
                }
                _opening = true;
                _threads = threads;
                _queue = std::move(queue);
                const F_err opened = _files.open(path, choice, mode, true);
                if (opened != errors::NONE)
                {
                    _opening = false;
                    return opened;
                }
                _applicationId = applicationId;
                if (mode == files::OpenMode::OpenExisting || mode == files::OpenMode::OpenSelected)
                {
                    const auto folder = _files.workingDirectory();
                    const auto named = folder / (_files.projectName() + ".sqlite");
                    bool namedExists = false;
                    if (!files::FileManager::pathExists(named, namedExists))
                    {
                        abandon(true);
                        return errors::FAILED_OPEN_PROJECT;
                    }
                    bool valid = false;
                    if (namedExists)
                    {
                        std::error_code error;
                        const auto status = std::filesystem::symlink_status(named, error);
                        valid = !error && std::filesystem::is_regular_file(status) && looksLikeFrayDatabase(named);
                        if (!valid)
                        {
                            for (const auto& stem : databaseFiles(folder))
                            {
                                if (stem != _files.projectName() && looksLikeFrayDatabase(folder / (stem + ".sqlite")))
                                {
                                    log::engineError("Cannot open project: its database path is occupied.");
                                    abandon(true);
                                    return errors::PROJECT_DATABASE_OCCUPIED;
                                }
                            }
                        }
                    }
                    else
                    {
                        for (const auto& stem : databaseFiles(folder))
                            if (looksLikeFrayDatabase(folder / (stem + ".sqlite")))
                            {
                                valid = true;
                                break;
                            }
                    }
                    if (!valid)
                    {
                        log::engineError("Cannot open project: no valid Fray database.");
                        abandon(true);
                        return errors::INVALID_PROJECT_DATABASE;
                    }
                }
                if (mode == files::OpenMode::CreateInFolder || mode == files::OpenMode::CreateInFolderResolve)
                {
                    const auto folder = _files.workingDirectory();
                    for (const auto& stem : databaseFiles(folder))
                    {
                        if (looksLikeFrayDatabase(folder / (stem + ".sqlite")))
                        {
                            log::engineError("Cannot create project: the folder now contains a valid Fray database.");
                            abandon(false);
                            return errors::PROJECT_FOLDER_EXISTS;
                        }
                    }
                    const auto database = folder / (_files.projectName() + ".sqlite");
                    for (const auto* suffix : {"", "-wal", "-shm", "-journal"})
                    {
                        bool exists = false;
                        if (!files::FileManager::pathExists(database.string() + suffix, exists))
                        {
                            abandon(false);
                            return errors::FAILED_OPEN_PROJECT;
                        }
                        if (exists)
                        {
                            log::engineError("Cannot create project: a database file already exists.");
                            abandon(false);
                            return errors::PROJECT_DATABASE_OCCUPIED;
                        }
                    }
#ifdef _WIN32
                    HANDLE created = CreateFileW(database.c_str(), GENERIC_WRITE, 0, nullptr, CREATE_NEW,
                                                 FILE_ATTRIBUTE_NORMAL, nullptr);
                    if (created == INVALID_HANDLE_VALUE || !CloseHandle(created))
#else
                    const int created = ::open(database.c_str(), O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, 0600);
                    if (created < 0 || ::close(created) != 0)
#endif
                    {
                        log::engineError("Cannot create project database without overwriting an existing file.");
                        abandon(false);
                        return errors::FAILED_OPEN_PROJECT;
                    }
                }
                const F_err prepared = mode == files::OpenMode::CreateInFolder ||
                                       mode == files::OpenMode::CreateInFolderResolve
                    ? errors::NONE : prepareDatabase();
                if (prepared == errors::DATABASE_CONFLICT)
                    return prepared;
                if (prepared != errors::NONE)
                {
                    abandon(true);
                    return prepared;
                }
                return finishOpen();
            }

            // Database files that could be this project's, once open() returned DATABASE_CONFLICT.
            std::vector<std::string> databaseCandidates() const
            {
                std::lock_guard<std::recursive_mutex> lock(_mutex);
                return _candidates;
            }

            F_err resolveDatabase(
                const DatabaseChoice& choice)
            {
                std::lock_guard<std::recursive_mutex> lock(_mutex);
                if (!_pendingDatabase)
                {
                    log::engineError("No database choice is pending.");
                    return errors::FAILED_OPEN_PROJECT;
                }
                if (!choice.createNew)
                {
                    if (std::find(_candidates.begin(), _candidates.end(), choice.name) == _candidates.end())
                    {
                        log::engineError("Not a database candidate: %s", choice.name.c_str());
                        return errors::FAILED_OPEN_PROJECT;
                    }
                    if (!_files.snapshotDatabase(choice.name) ||
                        !files::FileManager::renameFolderDatabase(_files.workingDirectory(), choice.name,
                                                                  _files.projectName()))
                        return errors::FAILED_OPEN_PROJECT;
                }
                _pendingDatabase = false;
                _candidates.clear();
                return finishOpen();
            }

            // Gives up on a pending database choice. A working folder extracted for it is removed;
            // the .fry file is untouched.
            F_err cancelOpen()
            {
                std::lock_guard<std::recursive_mutex> lock(_mutex);
                if (!_pendingDatabase)
                {
                    log::engineError("No database choice is pending.");
                    return errors::FAILED_OPEN_PROJECT;
                }
                abandon(true);
                return errors::NONE;
            }

            void beginOpening() { _opening = true; }
            bool isOpening() const { return _opening; }

            // Registers a thread that belongs to this project. The project's own thread stays alive
            // while any registered thread runs. Returns 0 without a ThreadManager.
            threads::ThreadManager::Id registerThread(
                const std::string& name,
                std::function<void(threads::StopToken)> body)
            {
                std::lock_guard<std::mutex> lock(_threadMutex);
                if (_threads == nullptr)
                    return 0;
                const auto id = _threads->spawn(_files.projectName() + ":" + name, std::move(body));
                _registered.push_back(id);
                return id;
            }

            void stopThread(
                threads::ThreadManager::Id id)
            {
                threads::ThreadManager* threads;
                {
                    std::lock_guard<std::mutex> lock(_threadMutex);
                    threads = _threads;
                    _registered.erase(std::remove(_registered.begin(), _registered.end(), id), _registered.end());
                }
                if (threads == nullptr)
                    return;
                threads->requestStop(id);
                threads->join(id);
            }

            bool hasThreads() const
            {
                std::lock_guard<std::mutex> lock(_threadMutex);
                if (_threads == nullptr)
                    return false;
                for (const auto id : _registered)
                    if (_threads->running(id))
                        return true;
                return false;
            }

            void setRenameCallback(
                std::function<void(const std::filesystem::path&)> callback)
            {
                std::lock_guard<std::recursive_mutex> lock(_mutex);
                _onRenamed = std::move(callback);
            }

            watch::FileWatcher& watcher() { return _watcher; }

            // Polls the folder and handles what changed on the calling thread.
            // Recreates the lock file if it was renamed or deleted while the project is open.
            void restoreLock()
            {
                std::lock_guard<std::recursive_mutex> lock(_mutex);
                if (_open && !_closing)
                    _files.restoreLock();
            }

            void pump()
            {
                std::lock_guard<std::recursive_mutex> lock(_mutex);
                if (_open && !_closing)
                    _watcher.dispatch();
            }

            F_err refreshFiles()
            {
                _watcher.poll();
                pump();
                return errors::NONE;
            }

            F_err rename(
                const std::string& newName)
            {
                std::lock_guard<std::recursive_mutex> lock(_mutex);
                if (!_open || _closing)
                {
                    log::engineError("Cannot rename project: project is closed or closing.");
                    return errors::FAILED_RENAME_PROJECT;
                }
                if (newName == _files.projectName())
                    return errors::NONE;
                return applyName(newName, _files.workingDirectory(), true, "");
            }

            bool isOpen() const { return _open; }
            std::string name() const
            {
                std::lock_guard<std::recursive_mutex> lock(_mutex);
                return _files.projectName();
            }
            std::string applicationId() const
            {
                std::lock_guard<std::recursive_mutex> lock(_mutex);
                return _applicationId;
            }
            files::FileManager& fileManager() { return _files; }

            F_err openState(
                const std::string& name)
            {
                std::lock_guard<std::recursive_mutex> lock(_mutex);
                if (!_open || _closing)
                {
                    log::engineError("Cannot open state: project is closed or closing.");
                    return errors::FAILED_OPEN_STORE;
                }
                auto found = _states.find(name);
                if (found != _states.end() && found->second->isOpen())
                    return errors::NONE;
                auto manager = std::make_unique<state::StateManager>();
                const F_err result = manager->open(_files, name, _applicationId);
                if (result != errors::NONE)
                    return result;
                _states[name] = std::move(manager);
                return errors::NONE;
            }

            state::StateManager& state(
                const std::string& name)
            {
                std::lock_guard<std::recursive_mutex> lock(_mutex);
                const auto found = _states.find(name);
                if (!_open || found == _states.end() || !found->second->isOpen())
                    throw std::out_of_range("Project state manager is not open: " + name);
                return *found->second;
            }

            template<typename T>
            F_err set(
                const std::string& key,
                const T& value)
            {
                std::lock_guard<std::recursive_mutex> lock(_mutex);
                if (key == "project.info.name")
                {
                    // Renaming the project renames its folder and database too.
                    if constexpr (std::is_convertible_v<const T&, std::string>)
                        return rename(std::string(value));
                    log::engineError("project.info.name must be a string.");
                    return errors::FAILED_SAVE_STATE;
                }
                if (!_open || !_states.at("Fray")->isOpen())
                {
                    log::engineError("Cannot save state: project is closed.");
                    return errors::FAILED_SAVE_STATE;
                }
                return _states.at("Fray")->set(key, value);
            }

            template<typename T>
            F_err get(
                const std::string& key,
                T& value)
            {
                std::lock_guard<std::recursive_mutex> lock(_mutex);
                if (!_open || !_states.at("Fray")->isOpen())
                {
                    log::engineError("Cannot load state: project is closed.");
                    return errors::FAILED_LOAD_STATE;
                }
                return _states.at("Fray")->get(key, value);
            }

            F_err handleProjectMessage(
                const ProjectCloseRequest& request,
                bool& packaged);

            F_err close(
                bool forcePackage = false,
                bool* packaged = nullptr)
            {
                std::lock_guard<std::recursive_mutex> lock(_mutex);
                if (!_open)
                {
                    log::engineError("Cannot close project: project is not open.");
                    return errors::FAILED_CLOSE_PROJECT;
                }
                stopWatching();
                if (!_closing)
                {
                    if (openState("Fray") != errors::NONE)
                        return errors::FAILED_CLOSE_PROJECT;
                    auto& state = *_states.at("Fray");
                    F_bool exists = false;
                    if (state.contains("project.preferences.packageOnClose", exists) != errors::NONE)
                        return errors::FAILED_CLOSE_PROJECT;
                    _packageOnClose = false;
                    if (!forcePackage && exists && state.get("project.preferences.packageOnClose", _packageOnClose) != errors::NONE)
                    {
                        log::engineError("Cannot close project: packageOnClose must be a boolean.");
                        return errors::FAILED_CLOSE_PROJECT;
                    }
                    if (forcePackage)
                        _packageOnClose = true;
                    _closing = true;
                }
                else if (forcePackage)
                    _packageOnClose = true;
                for (auto& entry : _states)
                    if (entry.second->isOpen() && entry.second->close() != errors::NONE)
                        return errors::FAILED_CLOSE_PROJECT;
                if (_packageOnClose && !_archiveComplete)
                {
                    if (_files.save() != errors::NONE)
                        return errors::FAILED_SAVE_PROJECT;
                    _archiveComplete = true;
                }
                if (_packageOnClose && _files.removeWorkingDirectory() != errors::NONE)
                    return errors::FAILED_CLOSE_PROJECT;
                if (_files.close() != errors::NONE)
                    return errors::FAILED_CLOSE_PROJECT;
                if (packaged)
                    *packaged = _packageOnClose;
                _states.clear();
                _applicationId.clear();
                _open = false;
                _closing = false;
                _packageOnClose = false;
                _archiveComplete = false;
                return errors::NONE;
            }
    };
}

#endif
