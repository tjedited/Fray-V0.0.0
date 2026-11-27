#ifndef FRAY_FILE_MANAGER_HPP
#define FRAY_FILE_MANAGER_HPP

#include <cstdlib>
#include <cerrno>
#include <cstdio>
#include <ctime>
#include <filesystem>
#include <fstream>
#include <memory>
#include <set>
#include <string>
#include <system_error>
#include <vector>

#include <zip.h>

#include "errors.hpp"
#include "log_manager.hpp"

#ifdef _WIN32
#include <fcntl.h>
#include <io.h>
#include <share.h>
#include <sys/stat.h>
#ifndef NOMINMAX
#define NOMINMAX
#endif
#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#include <windows.h>
#else
#include <fcntl.h>
#include <sys/file.h>
#include <sys/stat.h>
#include <unistd.h>
#ifdef __linux__
#include <sys/syscall.h>
#include <linux/fs.h>
#endif
#endif

namespace fray { namespace state { class StateManager; } }
namespace fray { class ProjectManager; }

namespace fray
{
    namespace files
    {
        enum class ConflictChoice { Ask, Archive, Folder };
        enum class OpenMode { OpenOrCreate, CreateNew, OpenExisting, OpenSelected, CreateInFolder,
                              CreateInFolderResolve };

        class FileManager
        {
            private:
                friend class fray::state::StateManager;
                friend class fray::ProjectManager;
                std::filesystem::path _archive;
                std::filesystem::path _workspace;
                std::string _name;
                bool _archiveExists = false;
                bool _extracted = false;
                struct ProjectLock
                {
#ifdef _WIN32
                    HANDLE handle = INVALID_HANDLE_VALUE;
#else
                    int handle = -1;
#endif
                    std::filesystem::path path;
                };
                ProjectLock _lock;
                ProjectLock _extraLock;
                std::filesystem::path _conflictSource;
                std::filesystem::path _conflictDestination;
                std::string _conflictName;
                bool _conflictFolder = false;
                unsigned _users = 0;
                std::shared_ptr<int> _lifetime = std::make_shared<int>(0);

                static bool safeRelative(
                    const std::string& name)
                {
                    if (name.empty() || name.find('\0') != std::string::npos ||
                        name.find('\\') != std::string::npos || name.find(':') != std::string::npos)
                        return false;
                    const std::filesystem::path path(name);
                    if (path.is_absolute() || path.has_root_name() || path.has_root_directory())
                        return false;
                    for (const auto& part : path)
                        if (part == "." || part == "..")
                            return false;
                    return true;
                }

                bool lockProject(
                    const std::filesystem::path& archive,
                    ProjectLock& lock)
                {
                    auto lockPath = archive;
                    lockPath.replace_extension(".lock");
#ifdef _WIN32
                    lock.handle = CreateFileW(lockPath.c_str(), GENERIC_READ | GENERIC_WRITE | DELETE, 0,
                                              nullptr, OPEN_ALWAYS, FILE_ATTRIBUTE_NORMAL | FILE_FLAG_OPEN_REPARSE_POINT,
                                              nullptr);
                    if (lock.handle != INVALID_HANDLE_VALUE)
                    {
                        BY_HANDLE_FILE_INFORMATION info;
                        if (!GetFileInformationByHandle(lock.handle, &info) ||
                            (info.dwFileAttributes & (FILE_ATTRIBUTE_DIRECTORY | FILE_ATTRIBUTE_REPARSE_POINT)) ||
                            info.nFileSizeHigh != 0 || info.nFileSizeLow != 0)
                        {
                            CloseHandle(lock.handle);
                            lock.handle = INVALID_HANDLE_VALUE;
                        }
                    }
                    if (lock.handle == INVALID_HANDLE_VALUE)
#else
                    lock.handle = ::open(lockPath.c_str(), O_CREAT | O_RDWR | O_NOFOLLOW, 0600);
                    if (lock.handle >= 0 && flock(lock.handle, LOCK_EX | LOCK_NB) != 0)
                    {
                        ::close(lock.handle);
                        lock.handle = -1;
                    }
                    if (lock.handle >= 0)
                    {
                        // A previous owner may have unlinked this inode before we acquired it.
                        struct stat descriptor, pathStatus;
                        if (fstat(lock.handle, &descriptor) != 0 || lstat(lockPath.c_str(), &pathStatus) != 0 ||
                            descriptor.st_dev != pathStatus.st_dev || descriptor.st_ino != pathStatus.st_ino ||
                            !S_ISREG(pathStatus.st_mode) || descriptor.st_size != 0)
                        {
                            ::close(lock.handle);
                            lock.handle = -1;
                        }
                    }
                    if (lock.handle < 0)
#endif
                    {
                        fray::log::engineError("Cannot lock project: %s", lockPath.string().c_str());
                        return false;
                    }
                    lock.path = lockPath;
                    return true;
                }

#ifndef _WIN32
                static bool lockIntact(
                    const ProjectLock& lock)
                {
                    struct stat descriptor, pathStatus;
                    return lock.handle >= 0 && fstat(lock.handle, &descriptor) == 0 &&
                           lstat(lock.path.c_str(), &pathStatus) == 0 && descriptor.st_dev == pathStatus.st_dev &&
                           descriptor.st_ino == pathStatus.st_ino && S_ISREG(pathStatus.st_mode) &&
                           descriptor.st_size == 0;
                }
#endif

                // Recreates the lock file if the user renamed or deleted it while the project is open.
                void restoreLock()
                {
#ifndef _WIN32
                    if (_lock.handle < 0 || _archive.empty() || lockIntact(_lock))
                        return;
                    ::close(_lock.handle);
                    _lock = ProjectLock();
                    if (lockProject(_archive, _lock))
                        fray::log::engineInfo("Project lock was missing and has been recreated.");
#endif
                }

                static bool unlockProject(
                    ProjectLock& lock)
                {
#ifdef _WIN32
                    if (lock.handle == INVALID_HANDLE_VALUE)
                        return true;
                    FILE_DISPOSITION_INFO disposition = {TRUE};
                    if (!SetFileInformationByHandle(lock.handle, FileDispositionInfo, &disposition, sizeof(disposition)))
                    {
                        fray::log::engineError("Cannot remove project lock: %s", lock.path.string().c_str());
                        return false;
                    }
                    if (!CloseHandle(lock.handle))
                    {
                        fray::log::engineError("Cannot release project lock: %s", lock.path.string().c_str());
                        return false;
                    }
                    lock.handle = INVALID_HANDLE_VALUE;
#else
                    if (lock.handle < 0)
                        return true;
                    // A lock that was renamed or deleted by the user is no longer ours to remove.
                    if (lockIntact(lock) && ::unlink(lock.path.c_str()) != 0)
                    {
                        fray::log::engineError("Cannot remove project lock: %s", lock.path.string().c_str());
                        return false;
                    }
                    ::close(lock.handle);
                    lock.handle = -1;
#endif
                    lock.path.clear();
                    return true;
                }

                bool reset()
                {
                    if (!unlockProject(_extraLock) || !unlockProject(_lock))
                        return false;
                    _archive.clear();
                    _workspace.clear();
                    _name.clear();
                    _archiveExists = false;
                    _extracted = false;
                    _conflictSource.clear();
                    _conflictDestination.clear();
                    _conflictName.clear();
                    return true;
                }

                bool rollbackConflict()
                {
                    if (_conflictSource.empty())
                        return true;
                    const bool databaseRestored = _conflictFolder
                        ? renameFolderDatabase(_conflictDestination, _conflictName, _name)
                        : renameArchiveDatabase(_conflictDestination, _conflictName, _name);
                    if (!databaseRestored)
                    {
                        fray::log::engineError("Cannot restore the unselected project's database name.");
                        return false;
                    }
                    if (!renameExclusive(_conflictDestination, _conflictSource))
                    {
                        const bool reverted = _conflictFolder
                            ? renameFolderDatabase(_conflictDestination, _name, _conflictName)
                            : renameArchiveDatabase(_conflictDestination, _name, _conflictName);
                        if (!reverted)
                            fray::log::engineError("Cannot restore the renamed project's database name.");
                        fray::log::engineError("Cannot restore the unselected project to %s.",
                                               _conflictSource.string().c_str());
                        return false;
                    }
                    _conflictSource.clear();
                    _conflictDestination.clear();
                    _conflictName.clear();
                    return true;
                }

                bool commitConflict()
                {
                    if (!unlockProject(_extraLock))
                        return false;
                    _conflictSource.clear();
                    _conflictDestination.clear();
                    _conflictName.clear();
                    return true;
                }

                // Copies <workspace>/<stem>.sqlite into <workspace>/snapshots as <stem>-<yyyymmddhhmmss>[-#].sqlite.
                // Call while the database is closed. A missing database is not an error.
                bool snapshotDatabase(
                    const std::string& stem)
                {
                    const auto database = _workspace / (stem + ".sqlite");
                    bool exists;
                    if (!pathExists(database, exists))
                        return false;
                    if (!exists)
                        return true;
                    const std::time_t now = std::time(nullptr);
                    std::tm local{};
#ifdef _WIN32
                    localtime_s(&local, &now);
#else
                    localtime_r(&now, &local);
#endif
                    char stamp[16];
                    std::strftime(stamp, sizeof(stamp), "%Y%m%d%H%M%S", &local);
                    const auto folder = _workspace / "snapshots";
                    std::error_code error;
                    std::filesystem::create_directory(folder, error);
                    if (error)
                    {
                        fray::log::engineError("Cannot create snapshots folder: %s", error.message().c_str());
                        return false;
                    }
                    auto target = folder / (stem + "-" + stamp + ".sqlite");
                    for (unsigned number = 1; ; ++number)
                    {
                        if (!pathExists(target, exists))
                            return false;
                        if (!exists)
                            break;
                        target = folder / (stem + "-" + stamp + "-" + std::to_string(number) + ".sqlite");
                    }
                    std::filesystem::copy_file(database, target, std::filesystem::copy_options::none, error);
                    if (error)
                    {
                        fray::log::engineError("Cannot snapshot project database: %s", error.message().c_str());
                        return false;
                    }
                    return true;
                }

                // Deletes the .fry the working folder was extracted from; it is recreated when packaging.
                void removeArchive()
                {
                    if (!_archiveExists)
                        return;
                    std::error_code error;
                    std::filesystem::remove(_archive, error);
                    if (error)
                        fray::log::engineError("Cannot remove %s while the project is open: %s",
                                               _archive.string().c_str(), error.message().c_str());
                    else
                        _archiveExists = false;
                }

                // Locks the archive path the project will have under `newName`; fails if it is taken.
                bool acquireRename(
                    const std::string& newName,
                    ProjectLock& lock)
                {
                    restoreLock();
                    const auto newArchive = _archive.parent_path() / (newName + ".fry");
                    bool exists;
                    if (!pathExists(newArchive, exists))
                        return false;
                    if (exists)
                    {
                        fray::log::engineError("Cannot rename project: %s already exists.", newArchive.string().c_str());
                        return false;
                    }
                    return lockProject(newArchive, lock);
                }

                void commitRename(
                    const std::string& newName,
                    const std::filesystem::path& workspace,
                    ProjectLock& lock)
                {
                    ProjectLock previous = _lock;
                    _lock = lock;
                    lock = ProjectLock();
                    _name = newName;
                    _workspace = workspace;
                    _archive = _archive.parent_path() / (newName + ".fry");
                    if (!unlockProject(previous))
                        fray::log::engineError("The previous project lock could not be removed.");
                }

                static bool pathExists(
                    const std::filesystem::path& path,
                    bool& exists)
                {
                    std::error_code error;
                    const auto status = std::filesystem::symlink_status(path, error);
                    if (error && error != std::errc::no_such_file_or_directory)
                    {
                        fray::log::engineError("Cannot inspect project path: %s", error.message().c_str());
                        return false;
                    }
                    exists = status.type() != std::filesystem::file_type::not_found;
                    return true;
                }

                static bool unusedPath(
                    const std::filesystem::path& parent,
                    const std::string& stem,
                    std::filesystem::path& output)
                {
                    for (unsigned i = 1; i < 100000; ++i)
                    {
                        const auto candidate = parent / (stem + "-" + std::to_string(i));
                        bool folderExists, archiveExists;
                        if (!pathExists(candidate, folderExists) ||
                            !pathExists(candidate.string() + ".fry", archiveExists))
                            return false;
                        if (!folderExists && !archiveExists)
                        {
                            output = candidate;
                            return true;
                        }
                    }
                    fray::log::engineError("Cannot find an unused project path.");
                    return false;
                }

                static bool renameExclusive(
                    const std::filesystem::path& from,
                    const std::filesystem::path& to)
                {
#ifdef _WIN32
                    if (MoveFileW(from.c_str(), to.c_str()) != 0)
                        return true;
                    const std::error_code error(static_cast<int>(GetLastError()), std::system_category());
#elif defined(__APPLE__)
                    if (::renamex_np(from.c_str(), to.c_str(), RENAME_EXCL) == 0)
                        return true;
                    const std::error_code error(errno, std::generic_category());
#elif defined(__linux__)
                    if (::syscall(SYS_renameat2, AT_FDCWD, from.c_str(), AT_FDCWD, to.c_str(), RENAME_NOREPLACE) == 0)
                        return true;
                    const std::error_code error(errno, std::generic_category());
#else
                    const std::error_code error = std::make_error_code(std::errc::operation_not_supported);
#endif
                    fray::log::engineError("Cannot rename %s to %s: %s",
                        from.string().c_str(), to.string().c_str(), error.message().c_str());
                    return false;
                }

                static bool renameFolderDatabase(
                    const std::filesystem::path& folder,
                    const std::string& oldName,
                    const std::string& newName)
                {
                    std::vector<std::pair<std::filesystem::path, std::filesystem::path>> renamed;
                    for (const char* suffix : {".sqlite", ".sqlite-wal", ".sqlite-shm", ".sqlite-journal"})
                    {
                        const auto from = folder / (oldName + suffix);
                        const auto to = folder / (newName + suffix);
                        bool exists, destinationExists;
                        if (!pathExists(from, exists) || !pathExists(to, destinationExists))
                            return false;
                        if (exists && destinationExists)
                        {
                            fray::log::engineError("Cannot rename project database: destination already exists: %s",
                                                   to.string().c_str());
                            return false;
                        }
                        if (exists)
                            renamed.emplace_back(from, to);
                    }
                    std::size_t completed = 0;
                    for (; completed < renamed.size(); ++completed)
                    {
                        if (!renameExclusive(renamed[completed].first, renamed[completed].second))
                        {
                            while (completed > 0)
                            {
                                --completed;
                                if (!renameExclusive(renamed[completed].second, renamed[completed].first))
                                    fray::log::engineError("Could not restore a renamed project database file.");
                            }
                            return false;
                        }
                    }
                    return true;
                }

                static bool renameArchiveDatabase(
                    const std::filesystem::path& path,
                    const std::string& oldName,
                    const std::string& newName)
                {
                    int error = 0;
                    zip_t* archive = zip_open(path.string().c_str(), ZIP_CHECKCONS, &error);
                    if (!archive)
                    {
                        if (error == ZIP_ER_NOZIP || error == ZIP_ER_INCONS || error == ZIP_ER_EOF)
                        {
                            fray::log::engineInfo("Unselected file is not a readable ZIP; leaving its contents unchanged: %s",
                                                  path.string().c_str());
                            return true;
                        }
                        fray::log::engineError("Cannot open renamed project archive (zip error %d).", error);
                        return false;
                    }
                    bool changed = false;
                    for (const char* suffix : {".sqlite", ".sqlite-wal", ".sqlite-shm", ".sqlite-journal"})
                    {
                        const std::string from = oldName + suffix;
                        const std::string to = newName + suffix;
                        const zip_int64_t index = zip_name_locate(archive, from.c_str(), 0);
                        if (index < 0)
                        {
                            if (zip_error_code_zip(zip_get_error(archive)) == ZIP_ER_NOENT)
                                continue;
                            fray::log::engineError("Cannot inspect renamed project archive: %s", zip_strerror(archive));
                            zip_discard(archive);
                            return false;
                        }
                        if (zip_name_locate(archive, to.c_str(), 0) >= 0)
                        {
                            fray::log::engineError("Cannot rename archived project database: destination already exists: %s",
                                                   to.c_str());
                            zip_discard(archive);
                            return false;
                        }
                        if (zip_error_code_zip(zip_get_error(archive)) != ZIP_ER_NOENT)
                        {
                            fray::log::engineError("Cannot inspect renamed project archive: %s", zip_strerror(archive));
                            zip_discard(archive);
                            return false;
                        }
                        if (zip_file_rename(archive, static_cast<zip_uint64_t>(index),
                                            to.c_str(), ZIP_FL_ENC_UTF_8) != 0)
                        {
                            fray::log::engineError("Cannot rename archived project database: %s", zip_strerror(archive));
                            zip_discard(archive);
                            return false;
                        }
                        changed = true;
                    }
                    if (!changed)
                    {
                        zip_discard(archive);
                        return true;
                    }
                    if (zip_close(archive) != 0)
                    {
                        fray::log::engineError("Cannot update renamed project archive: %s", zip_strerror(archive));
                        zip_discard(archive);
                        return false;
                    }
                    return true;
                }

                bool extract()
                {
                    int error = 0;
                    zip_t* archive = zip_open(_archive.string().c_str(), ZIP_RDONLY | ZIP_CHECKCONS, &error);
                    if (!archive)
                    {
                        fray::log::engineError("Cannot open project archive (zip error %d).", error);
                        return false;
                    }
                    std::error_code fsError;
                    if (!std::filesystem::create_directory(_workspace, fsError))
                    {
                        fray::log::engineError("Cannot create project folder: %s", fsError.message().c_str());
                        zip_discard(archive);
                        return false;
                    }
                    bool ok = true;
                    std::set<std::string> paths;
                    const zip_int64_t entries = zip_get_num_entries(archive, 0);
                    if (entries < 0)
                        ok = false;
                    for (zip_uint64_t i = 0; ok && i < static_cast<zip_uint64_t>(entries); ++i)
                    {
                        const char* raw = zip_get_name(archive, i, 0);
                        const std::string name = raw == nullptr ? "" : raw;
                        zip_uint8_t system = 0;
                        zip_uint32_t attributes = 0;
                        if (!safeRelative(name) || !paths.insert(name).second ||
                            zip_file_get_external_attributes(archive, i, 0, &system, &attributes) != 0)
                        {
                            fray::log::engineError("Invalid project archive entry: %s", name.c_str());
                            ok = false;
                            break;
                        }
                        const unsigned type = system == ZIP_OPSYS_UNIX ? (attributes >> 16) & 0170000 : 0;
                        const bool directory = name.back() == '/';
                        if ((type != 0 && type != 0100000 && type != 0040000) ||
                            (type == 0040000 && !directory) || (type == 0100000 && directory))
                        {
                            fray::log::engineError("Unsupported project archive entry: %s", name.c_str());
                            ok = false;
                            break;
                        }
                        const auto destination = _workspace / std::filesystem::path(name);
                        if (directory)
                        {
                            std::filesystem::create_directories(destination, fsError);
                            ok = !fsError;
                            continue;
                        }
                        std::filesystem::create_directories(destination.parent_path(), fsError);
                        if (fsError || std::filesystem::exists(destination, fsError) || fsError)
                        {
                            fray::log::engineError("Cannot extract project entry: %s", name.c_str());
                            ok = false;
                            break;
                        }
                        zip_file_t* entry = zip_fopen_index(archive, i, 0);
                        if (!entry)
                        {
                            fray::log::engineError("Cannot read project entry: %s", name.c_str());
                            ok = false;
                            break;
                        }
                        std::ofstream output(destination, std::ios::binary | std::ios::trunc);
                        char buffer[65536];
                        zip_int64_t count = -1;
                        while (output && (count = zip_fread(entry, buffer, sizeof(buffer))) > 0)
                            output.write(buffer, count);
                        output.close();
                        const int closed = zip_fclose(entry);
                        if (count < 0 || !output || closed != 0)
                        {
                            fray::log::engineError("Cannot extract project entry: %s", name.c_str());
                            ok = false;
                        }
                    }
                    if (!ok && fsError)
                        fray::log::engineError("Cannot extract project: %s", fsError.message().c_str());
                    zip_discard(archive);
                    if (!ok)
                    {
                        std::filesystem::remove_all(_workspace, fsError);
                        if (fsError)
                            fray::log::engineError("Cannot remove incomplete project folder: %s", fsError.message().c_str());
                    }
                    return ok;
                }

            public:
                FileManager() = default;
                FileManager(
                    const FileManager&) = delete;
                FileManager& operator=(
                    const FileManager&) = delete;

                ~FileManager()
                {
                    if (_users != 0)
                        fray::log::engineError("File manager destroyed while state managers are still using it.");
                    _lifetime.reset();
                    if (!reset())
                    {
#ifdef _WIN32
                        if (_extraLock.handle != INVALID_HANDLE_VALUE)
                            CloseHandle(_extraLock.handle);
                        if (_lock.handle != INVALID_HANDLE_VALUE)
                            CloseHandle(_lock.handle);
#else
                        if (_extraLock.handle >= 0)
                            ::close(_extraLock.handle);
                        if (_lock.handle >= 0)
                            ::close(_lock.handle);
#endif
                    }
                }

                bool isOpen() const { return !_workspace.empty(); }
                const std::string& projectName() const { return _name; }
                const std::filesystem::path& workingDirectory() const { return _workspace; }
                const std::filesystem::path& archivePath() const { return _archive; }

                F_err filePath(
                    const std::string& name,
                    std::filesystem::path& result) const
                {
                    if (!isOpen() || !safeRelative(name))
                    {
                        fray::log::engineError("Cannot access project file: project is closed or path is invalid.");
                        return fray::errors::FAILED_OPEN_PROJECT;
                    }
                    std::filesystem::path current = _workspace;
                    for (const auto& part : std::filesystem::path(name))
                    {
                        current /= part;
                        std::error_code error;
                        const auto status = std::filesystem::symlink_status(current, error);
                        if ((error && error != std::errc::no_such_file_or_directory) ||
                            std::filesystem::is_symlink(status))
                        {
                            fray::log::engineError("Cannot access project file: invalid or symbolic-link path.");
                            return fray::errors::FAILED_OPEN_PROJECT;
                        }
                    }
                    result = current;
                    return fray::errors::NONE;
                }

                F_err open(
                    const std::string& path,
                    ConflictChoice choice = ConflictChoice::Ask,
                    OpenMode mode = OpenMode::OpenOrCreate,
                    bool deferConflictCommit = false)
                {
                    if (isOpen() || !_lock.path.empty() || !_extraLock.path.empty() ||
                        path.empty() || path.find('\0') != std::string::npos)
                    {
                        fray::log::engineError("Cannot open project: invalid path or project already open.");
                        return fray::errors::FAILED_OPEN_PROJECT;
                    }
                    std::error_code error;
                    auto input = std::filesystem::weakly_canonical(path, error);
                    if (error)
                    {
                        fray::log::engineError("Cannot resolve project path: %s", error.message().c_str());
                        return fray::errors::FAILED_OPEN_PROJECT;
                    }
                    if (input.filename().empty() && input != input.root_path())
                        input = input.parent_path();
                    const bool inputArchive = input.extension() == ".fry";
                    _name = inputArchive ? input.stem().string() : input.filename().string();
                    if (_name.empty() || _name == "." || _name == "..")
                    {
                        fray::log::engineError("Cannot open project: invalid project name.");
                        reset();
                        return fray::errors::FAILED_OPEN_PROJECT;
                    }
                    const auto parent = input.parent_path();
                    const auto originalArchive = inputArchive ? input : parent / (_name + ".fry");
                    const auto originalFolder = inputArchive ? parent / _name : input;
                    bool hasArchive = std::filesystem::exists(originalArchive, error);
                    if (error)
                    {
                        fray::log::engineError("Cannot inspect project archive: %s", error.message().c_str());
                        reset();
                        return fray::errors::FAILED_OPEN_PROJECT;
                    }
                    bool hasFolder = std::filesystem::exists(originalFolder, error);
                    if (error || (hasFolder && !std::filesystem::is_directory(originalFolder, error)))
                    {
                        fray::log::engineError("Cannot inspect project folder: %s", error.message().c_str());
                        reset();
                        return fray::errors::FAILED_OPEN_PROJECT;
                    }
                    if (hasFolder && std::filesystem::is_symlink(std::filesystem::symlink_status(originalFolder, error)))
                    {
                        fray::log::engineError("Cannot open a symbolic-link project folder.");
                        reset();
                        return fray::errors::FAILED_OPEN_PROJECT;
                    }
                    if (error)
                    {
                        fray::log::engineError("Cannot inspect project folder: %s", error.message().c_str());
                        reset();
                        return fray::errors::FAILED_OPEN_PROJECT;
                    }
                    if (hasArchive && hasFolder &&
                        ((choice == ConflictChoice::Ask && mode != OpenMode::CreateNew) ||
                         mode == OpenMode::OpenSelected || mode == OpenMode::CreateInFolder))
                    {
                        reset();
                        return fray::errors::PROJECT_CONFLICT;
                    }
                    if (!lockProject(originalArchive, _lock))
                    {
                        reset();
                        return fray::errors::FAILED_OPEN_PROJECT;
                    }
                    hasArchive = std::filesystem::exists(originalArchive, error);
                    if (!error)
                        hasFolder = std::filesystem::exists(originalFolder, error);
                    if (error)
                    {
                        fray::log::engineError("Cannot inspect project after locking: %s", error.message().c_str());
                        reset();
                        return fray::errors::FAILED_OPEN_PROJECT;
                    }
                    if (mode == OpenMode::CreateNew && (hasArchive || hasFolder))
                    {
                        const F_err result = hasArchive && hasFolder ? errors::PROJECT_BOTH_EXIST :
                            hasArchive ? errors::PROJECT_ARCHIVE_EXISTS : errors::PROJECT_FOLDER_EXISTS;
                        reset();
                        return result;
                    }
                    if ((mode == OpenMode::OpenExisting || mode == OpenMode::OpenSelected) &&
                        ((!hasFolder && !hasArchive) ||
                         (choice == ConflictChoice::Archive && !hasArchive) ||
                         (choice == ConflictChoice::Folder && !hasFolder)))
                    {
                        reset();
                        return errors::PROJECT_NOT_FOUND;
                    }
                    if ((mode == OpenMode::CreateInFolder || mode == OpenMode::CreateInFolderResolve) && !hasFolder)
                    {
                        reset();
                        return errors::PROJECT_NOT_FOUND;
                    }
                    if (hasArchive && hasFolder &&
                        (choice == ConflictChoice::Ask || mode == OpenMode::OpenSelected ||
                         mode == OpenMode::CreateInFolder))
                    {
                        reset();
                        return fray::errors::PROJECT_CONFLICT;
                    }
                    const bool useArchive = hasArchive && (!hasFolder || choice == ConflictChoice::Archive);
                    _archive = originalArchive;
                    _archiveExists = hasArchive;
                    _workspace = originalFolder;
                    if (hasArchive && hasFolder)
                    {
                        std::filesystem::path extra;
                        if (!unusedPath(parent, _name + "-unselected", extra) ||
                            !lockProject(extra.string() + ".fry", _extraLock))
                        {
                            reset();
                            return fray::errors::FAILED_OPEN_PROJECT;
                        }
                        const std::string newName = extra.filename().string();
                        const auto source = useArchive ? originalFolder : originalArchive;
                        const std::filesystem::path destination = useArchive
                            ? extra : std::filesystem::path(extra.string() + ".fry");
                        bool folderExists, archiveExists;
                        if (!pathExists(extra, folderExists) ||
                            !pathExists(extra.string() + ".fry", archiveExists) ||
                            folderExists || archiveExists || !renameExclusive(source, destination))
                        {
                            fray::log::engineError("Cannot resolve project naming conflict.");
                            reset();
                            return fray::errors::FAILED_OPEN_PROJECT;
                        }
                        const bool renamedDatabase = useArchive
                            ? renameFolderDatabase(destination, _name, newName)
                            : renameArchiveDatabase(destination, _name, newName);
                        if (!renamedDatabase)
                        {
                            if (!renameExclusive(destination, source))
                                fray::log::engineError("Could not restore the original project path after rename failed.");
                            reset();
                            return fray::errors::FAILED_OPEN_PROJECT;
                        }
                        fray::log::engineInfo("Renamed %s to %s", source.string().c_str(),
                                              destination.string().c_str());
                        _conflictSource = source;
                        _conflictDestination = destination;
                        _conflictName = newName;
                        _conflictFolder = useArchive;
                        if (!deferConflictCommit && !commitConflict())
                        {
                            rollbackConflict();
                            reset();
                            return fray::errors::FAILED_OPEN_PROJECT;
                        }
                        if (useArchive)
                            hasFolder = false;
                        else
                            _archiveExists = false;
                    }
                    if (useArchive)
                    {
                        if (!extract())
                        {
                            rollbackConflict();
                            reset();
                            return fray::errors::FAILED_OPEN_PROJECT;
                        }
                        _extracted = true;
                    }
                    else if (!hasFolder && !std::filesystem::create_directory(_workspace, error))
                    {
                        fray::log::engineError("Cannot create project folder: %s", error.message().c_str());
                        reset();
                        return fray::errors::FAILED_OPEN_PROJECT;
                    }
                    return fray::errors::NONE;
                }

                F_err save()
                {
                    if (!isOpen() || _users != 0)
                    {
                        fray::log::engineError("Cannot archive project: project is closed or state is still open.");
                        return fray::errors::FAILED_SAVE_PROJECT;
                    }
                    int error = 0;
                    zip_t* archive = zip_open(_archive.string().c_str(),
                        _archiveExists ? ZIP_TRUNCATE : ZIP_CREATE | ZIP_EXCL, &error);
                    if (!archive)
                    {
                        fray::log::engineError("Cannot create project archive (zip error %d).", error);
                        return fray::errors::FAILED_SAVE_PROJECT;
                    }
                    std::error_code fsError;
                    std::filesystem::recursive_directory_iterator it(_workspace, fsError), end;
                    bool ok = !fsError;
                    for (; ok && it != end; it.increment(fsError))
                    {
                        if (fsError)
                        {
                            ok = false;
                            break;
                        }
                        const auto status = it->symlink_status(fsError);
                        if (fsError || (!std::filesystem::is_regular_file(status) && !std::filesystem::is_directory(status)))
                        {
                            fray::log::engineError("Cannot archive unsupported project file: %s", it->path().string().c_str());
                            ok = false;
                            break;
                        }
                        const std::string name = it->path().lexically_relative(_workspace).generic_string();
                        if (!safeRelative(name))
                        {
                            fray::log::engineError("Cannot archive invalid project path: %s", name.c_str());
                            ok = false;
                            break;
                        }
                        if (std::filesystem::is_directory(status))
                            ok = zip_dir_add(archive, (name + "/").c_str(), ZIP_FL_ENC_UTF_8) >= 0;
                        else
                        {
                            const std::string path = it->path().string();
                            zip_source_t* source = zip_source_file(archive, path.c_str(), 0, -1);
                            if (!source)
                                ok = false;
                            else if (zip_file_add(archive, name.c_str(), source, ZIP_FL_ENC_UTF_8) < 0)
                            {
                                zip_source_free(source);
                                ok = false;
                            }
                        }
                    }
                    if (fsError)
                        ok = false;
                    if (!ok)
                    {
                        fray::log::engineError("Cannot archive project: %s",
                            fsError ? fsError.message().c_str() : zip_strerror(archive));
                        zip_discard(archive);
                        return fray::errors::FAILED_SAVE_PROJECT;
                    }
                    if (zip_close(archive) != 0)
                    {
                        fray::log::engineError("Cannot save project archive: %s", zip_strerror(archive));
                        zip_discard(archive);
                        return fray::errors::FAILED_SAVE_PROJECT;
                    }
                    _archiveExists = true;
                    return fray::errors::NONE;
                }

                F_err close()
                {
                    if (!isOpen() || _users != 0)
                    {
                        fray::log::engineError("Cannot close project: project is closed or state is still open.");
                        return fray::errors::FAILED_CLOSE_PROJECT;
                    }
                    return reset() ? fray::errors::NONE : fray::errors::FAILED_CLOSE_PROJECT;
                }

            private:
                F_err removeWorkingDirectory()
                {
                    if (!isOpen() || _users != 0)
                    {
                        fray::log::engineError("Cannot remove project folder: project is closed or state is still open.");
                        return fray::errors::FAILED_CLOSE_PROJECT;
                    }
                    std::error_code error;
                    const auto contains = [](const std::filesystem::path& parent, const std::filesystem::path& child)
                    {
                        auto part = parent.begin();
                        auto other = child.begin();
                        for (; part != parent.end() && other != child.end(); ++part, ++other)
                            if (*part != *other)
                                return false;
                        return part == parent.end();
                    };
                    const auto cwd = std::filesystem::current_path(error);
                    if (error)
                    {
                        fray::log::engineError("Cannot check project folder safety: %s", error.message().c_str());
                        return fray::errors::FAILED_CLOSE_PROJECT;
                    }
                    const auto current = std::filesystem::weakly_canonical(cwd, error);
                    if (error)
                    {
                        fray::log::engineError("Cannot check project folder safety: %s", error.message().c_str());
                        return fray::errors::FAILED_CLOSE_PROJECT;
                    }
                    bool protectedFolder = _workspace == _workspace.root_path() || contains(_workspace, current);
                    const char* home = std::getenv("HOME");
#ifdef _WIN32
                    if (home == nullptr || *home == '\0')
                        home = std::getenv("USERPROFILE");
#endif
                    if (home != nullptr && *home != '\0')
                    {
                        const auto homePath = std::filesystem::weakly_canonical(home, error);
                        if (error)
                        {
                            fray::log::engineError("Cannot check home directory safety: %s", error.message().c_str());
                            return fray::errors::FAILED_CLOSE_PROJECT;
                        }
                        protectedFolder = protectedFolder || contains(_workspace, homePath);
                    }
                    if (protectedFolder)
                    {
                        fray::log::engineError("Project was archived, but the protected working folder was not removed: %s",
                                               _workspace.string().c_str());
                        return fray::errors::FAILED_CLOSE_PROJECT;
                    }
                    std::filesystem::remove_all(_workspace, error);
                    if (error)
                    {
                        fray::log::engineError("Project was archived, but its working folder could not be removed: %s (%s)",
                                               _workspace.string().c_str(), error.message().c_str());
                        return fray::errors::FAILED_CLOSE_PROJECT;
                    }
                    return fray::errors::NONE;
                }

                void attach() { ++_users; }
                void detach() { --_users; }
                std::weak_ptr<int> lifetime() const { return _lifetime; }
        };
    }
}

#endif
