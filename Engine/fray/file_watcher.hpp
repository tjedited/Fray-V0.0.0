#ifndef FRAY_FILE_WATCHER_HPP
#define FRAY_FILE_WATCHER_HPP

#include <chrono>
#include <cstdint>
#include <deque>
#include <filesystem>
#include <functional>
#include <map>
#include <mutex>
#include <string>
#include <utility>
#include <vector>

#ifdef _WIN32
#ifndef NOMINMAX
#define NOMINMAX
#endif
#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#include <windows.h>
#else
#include <sys/stat.h>
#endif

#include "thread_manager.hpp"

namespace fray
{
    namespace watch
    {
        // Identity of a file that survives renames (device + inode, or volume + file index).
        struct FileId
        {
            std::uint64_t device = 0;
            std::uint64_t index = 0;

            bool valid() const { return device != 0 || index != 0; }
            bool operator==(
                const FileId& other) const { return device == other.device && index == other.index; }
            bool operator!=(
                const FileId& other) const { return !(*this == other); }
            bool operator<(
                const FileId& other) const
            {
                return device != other.device ? device < other.device : index < other.index;
            }
        };

        // Reads the identity of the entry itself; symbolic links are not followed.
        inline bool fileId(
            const std::filesystem::path& path,
            FileId& id)
        {
#ifdef _WIN32
            HANDLE handle = CreateFileW(path.c_str(), 0, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
                                        nullptr, OPEN_EXISTING,
                                        FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT, nullptr);
            if (handle == INVALID_HANDLE_VALUE)
                return false;
            BY_HANDLE_FILE_INFORMATION info;
            const bool ok = GetFileInformationByHandle(handle, &info) != 0;
            CloseHandle(handle);
            if (!ok)
                return false;
            id.device = info.dwVolumeSerialNumber;
            id.index = (static_cast<std::uint64_t>(info.nFileIndexHigh) << 32) | info.nFileIndexLow;
#else
            struct stat status;
            if (::lstat(path.c_str(), &status) != 0)
                return false;
            id.device = static_cast<std::uint64_t>(status.st_dev);
            id.index = static_cast<std::uint64_t>(status.st_ino);
#endif
            return id.valid();
        }

        enum class ChangeKind { Added, Removed, Renamed, Modified };

        struct Change
        {
            ChangeKind kind = ChangeKind::Modified;
            std::filesystem::path path;           // Absolute path when the change was detected.
            std::filesystem::path previousPath;   // Renamed: where it used to be.
            std::string relative;                 // Path inside the watched folder ("" for the folder itself).
            std::string previousRelative;         // Renamed: its old relative path.
            bool directory = false;
            bool root = false;                    // The change is to the watched folder itself.
            FileId id;                            // Identity of the entry (not set for Removed).
        };

        // Watches one folder tree by comparing snapshots. poll() finds changes and queues them;
        // dispatch() hands queued changes to matching subscribers on the calling thread, so handlers
        // run wherever the owner chooses. run() polls repeatedly and is meant for a ThreadManager thread.
        class FileWatcher
        {
            public:
                using Filter = std::function<bool(const Change&)>;
                using Handler = std::function<void(const Change&)>;
                using Subscription = std::uint64_t;

            private:
                struct Entry
                {
                    FileId id;
                    std::uintmax_t size = 0;
                    std::filesystem::file_time_type time;
                    bool directory = false;
                };
                using Snapshot = std::map<std::string, Entry>;
                struct Subscriber
                {
                    Subscription id;
                    Filter filter;
                    Handler handler;
                };

                mutable std::recursive_mutex _scan;
                std::filesystem::path _root;
                FileId _rootId;
                bool _watching = false;
                Snapshot _snapshot;

                std::mutex _queueMutex;
                std::deque<Change> _queue;
                std::vector<Subscriber> _subscribers;
                Subscription _nextSubscription = 1;
                std::function<void()> _notify;

                static Snapshot scanFolder(
                    const std::filesystem::path& root)
                {
                    Snapshot snapshot;
                    std::error_code error;
                    std::filesystem::recursive_directory_iterator it(
                        root, std::filesystem::directory_options::skip_permission_denied, error), end;
                    for (; !error && it != end; it.increment(error))
                    {
                        std::error_code entryError;
                        const auto status = it->symlink_status(entryError);
                        if (entryError)
                            continue;
                        Entry entry;
                        entry.directory = std::filesystem::is_directory(status);
                        if (!fileId(it->path(), entry.id))
                            continue;
                        if (!entry.directory)
                        {
                            entry.size = it->is_regular_file(entryError) ? it->file_size(entryError) : 0;
                            entry.time = std::filesystem::last_write_time(it->path(), entryError);
                        }
                        snapshot[it->path().lexically_relative(root).generic_string()] = entry;
                    }
                    return snapshot;
                }

                static bool inside(
                    const std::string& path,
                    const std::string& folder)
                {
                    return path.size() > folder.size() && path.compare(0, folder.size(), folder) == 0 &&
                           path[folder.size()] == '/';
                }

                void enqueue(
                    std::vector<Change>& changes)
                {
                    if (changes.empty())
                        return;
                    std::lock_guard<std::mutex> lock(_queueMutex);
                    for (auto& change : changes)
                        _queue.push_back(std::move(change));
                }

                void diff(
                    const Snapshot& before,
                    const Snapshot& after,
                    std::vector<Change>& changes) const
                {
                    std::map<FileId, std::string> added;
                    for (const auto& entry : after)
                        if (before.find(entry.first) == before.end())
                            added[entry.second.id] = entry.first;

                    std::vector<std::pair<std::string, std::string>> folderRenames;
                    std::vector<Change> renames, removals, additions, modifications;
                    std::map<std::string, bool> matched;
                    for (const auto& entry : before)
                    {
                        const auto now = after.find(entry.first);
                        if (now != after.end())
                        {
                            const Entry& was = entry.second;
                            const Entry& is = now->second;
                            if (was.id != is.id || (!is.directory && (was.size != is.size || was.time != is.time)))
                            {
                                Change change;
                                change.kind = ChangeKind::Modified;
                                change.relative = entry.first;
                                change.directory = is.directory;
                                change.id = is.id;
                                modifications.push_back(std::move(change));
                            }
                            continue;
                        }
                        const auto moved = added.find(entry.second.id);
                        Change change;
                        change.relative = entry.first;
                        change.directory = entry.second.directory;
                        if (moved == added.end())
                        {
                            change.kind = ChangeKind::Removed;
                            removals.push_back(std::move(change));
                            continue;
                        }
                        change.kind = ChangeKind::Renamed;
                        change.previousRelative = entry.first;
                        change.relative = moved->second;
                        change.id = entry.second.id;
                        matched[moved->second] = true;
                        if (change.directory)
                            folderRenames.emplace_back(change.previousRelative, change.relative);
                        renames.push_back(std::move(change));
                    }
                    for (const auto& entry : after)
                    {
                        if (before.find(entry.first) != before.end() || matched.count(entry.first))
                            continue;
                        Change change;
                        change.kind = ChangeKind::Added;
                        change.relative = entry.first;
                        change.directory = entry.second.directory;
                        change.id = entry.second.id;
                        additions.push_back(std::move(change));
                    }
                    const std::size_t first = changes.size();
                    // Children of a renamed folder moved with it; report only the folder.
                    for (auto& change : renames)
                    {
                        bool carried = false;
                        for (const auto& folder : folderRenames)
                            if (inside(change.previousRelative, folder.first) &&
                                change.relative == folder.second + change.previousRelative.substr(folder.first.size()))
                                carried = true;
                        if (!carried)
                            changes.push_back(std::move(change));
                    }
                    for (auto* group : {&removals, &additions, &modifications})
                        for (auto& change : *group)
                            changes.push_back(std::move(change));
                    for (std::size_t i = first; i < changes.size(); ++i)
                    {
                        Change& change = changes[i];
                        change.path = _root / std::filesystem::path(change.relative);
                        if (change.kind == ChangeKind::Renamed)
                            change.previousPath = _root / std::filesystem::path(change.previousRelative);
                    }
                }

            public:
                FileWatcher() = default;
                FileWatcher(
                    const FileWatcher&) = delete;
                FileWatcher& operator=(
                    const FileWatcher&) = delete;

                // Starts (or restarts) watching `root`, taking a silent baseline. Also used to
                // acknowledge a change the owner made itself.
                bool watch(
                    const std::filesystem::path& root)
                {
                    std::lock_guard<std::recursive_mutex> lock(_scan);
                    FileId id;
                    if (!fileId(root, id))
                        return false;
                    _root = root;
                    _rootId = id;
                    _snapshot = scanFolder(root);
                    _watching = true;
                    return true;
                }

                void unwatch()
                {
                    std::lock_guard<std::recursive_mutex> lock(_scan);
                    _watching = false;
                    _snapshot.clear();
                }

                // Blocks polling while held, so the owner can change files without being reported.
                std::unique_lock<std::recursive_mutex> hold() { return std::unique_lock<std::recursive_mutex>(_scan); }

                Subscription subscribe(
                    Filter filter,
                    Handler handler)
                {
                    std::lock_guard<std::mutex> lock(_queueMutex);
                    const Subscription id = _nextSubscription++;
                    _subscribers.push_back({id, std::move(filter), std::move(handler)});
                    return id;
                }

                void unsubscribe(
                    Subscription id)
                {
                    std::lock_guard<std::mutex> lock(_queueMutex);
                    for (auto it = _subscribers.begin(); it != _subscribers.end(); ++it)
                        if (it->id == id)
                        {
                            _subscribers.erase(it);
                            return;
                        }
                }

                // Called from the polling thread whenever poll() queued something.
                void setNotify(
                    std::function<void()> notify)
                {
                    std::lock_guard<std::mutex> lock(_queueMutex);
                    _notify = std::move(notify);
                }

                // Compares the folder with the last snapshot and queues what changed. Returns the count.
                std::size_t poll()
                {
                    std::vector<Change> changes;
                    {
                        std::lock_guard<std::recursive_mutex> lock(_scan);
                        if (!_watching)
                            return 0;
                        FileId current;
                        if (!fileId(_root, current) || current != _rootId)
                        {
                            // The folder is gone from this path; look for it under a new name next to it.
                            std::filesystem::path moved;
                            std::error_code error;
                            std::filesystem::directory_iterator it(_root.parent_path(), error), end;
                            for (; !error && it != end; it.increment(error))
                            {
                                FileId candidate;
                                if (fileId(it->path(), candidate) && candidate == _rootId)
                                {
                                    moved = it->path();
                                    break;
                                }
                            }
                            Change change;
                            change.root = true;
                            change.directory = true;
                            change.id = _rootId;
                            change.previousPath = _root;
                            if (moved.empty())
                            {
                                change.kind = ChangeKind::Removed;
                                change.path = _root;
                                _watching = false;
                                changes.push_back(std::move(change));
                                enqueue(changes);
                                return 1;
                            }
                            change.kind = ChangeKind::Renamed;
                            change.path = moved;
                            _root = moved;
                            changes.push_back(std::move(change));
                        }
                        Snapshot after = scanFolder(_root);
                        diff(_snapshot, after, changes);
                        _snapshot = std::move(after);
                        enqueue(changes);
                    }
                    return changes.size();
                }

                // Delivers queued changes to subscribers on the calling thread.
                std::size_t dispatch()
                {
                    std::deque<Change> changes;
                    std::vector<Subscriber> subscribers;
                    {
                        std::lock_guard<std::mutex> lock(_queueMutex);
                        changes.swap(_queue);
                        subscribers = _subscribers;
                    }
                    for (const auto& change : changes)
                        for (const auto& subscriber : subscribers)
                            if (!subscriber.filter || subscriber.filter(change))
                                subscriber.handler(change);
                    return changes.size();
                }

                // Polls until stopped; intended as the body of a ThreadManager thread.
                // `tick`, if given, runs once per interval after polling.
                void run(
                    const threads::StopToken& token,
                    std::function<void()> tick = nullptr,
                    std::chrono::milliseconds interval = std::chrono::milliseconds(1000))
                {
                    while (!token.waitFor(interval))
                    {
                        const std::size_t changes = poll();
                        if (tick)
                            tick();
                        if (changes == 0)
                            continue;
                        std::function<void()> notify;
                        {
                            std::lock_guard<std::mutex> lock(_queueMutex);
                            notify = _notify;
                        }
                        if (notify)
                            notify();
                    }
                }
        };
    }
}

#endif
