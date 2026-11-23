#ifndef FRAY_FILE_MANAGER_HPP
#define FRAY_FILE_MANAGER_HPP

#include <cstdlib>
#include <filesystem>
#include <fstream>
#include <memory>
#include <set>
#include <string>
#include <system_error>

#include <zip.h>

#include "errors.hpp"
#include "log.hpp"

#ifdef _WIN32
#include <fcntl.h>
#include <io.h>
#include <share.h>
#include <sys/stat.h>
#else
#include <fcntl.h>
#include <sys/file.h>
#include <unistd.h>
#endif

namespace fray { namespace state { class StateManager; } }
namespace fray { class ProjectManager; }

namespace fray
{
    namespace files
    {
        enum class ConflictChoice { Ask, Archive, Folder };

        class FileManager
        {
            private:
                friend class fray::state::StateManager;
                friend class fray::ProjectManager;
                std::filesystem::path _archive;
                std::filesystem::path _workspace;
                std::filesystem::path _extraDirectory;
                std::string _name;
                bool _archiveExists = false;
                int _lock = -1;
                int _extraLock = -1;
                unsigned _users = 0;
                std::shared_ptr<int> _lifetime = std::make_shared<int>(0);

                static bool safeRelative(const std::string& name)
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

                bool lockProject(const std::filesystem::path& archive, int& lock)
                {
                    const std::string path = archive.string() + ".lock";
#ifdef _WIN32
                    if (_sopen_s(&lock, path.c_str(), _O_CREAT | _O_RDWR | _O_BINARY,
                                 _SH_DENYRW, _S_IREAD | _S_IWRITE) != 0)
                        lock = -1;
#else
                    lock = ::open(path.c_str(), O_CREAT | O_RDWR | O_NOFOLLOW, 0600);
                    if (lock >= 0 && flock(lock, LOCK_EX | LOCK_NB) != 0)
                    {
                        ::close(lock);
                        lock = -1;
                    }
#endif
                    if (lock < 0)
                        fray::log::engineError("Cannot lock project: %s", path.c_str());
                    return lock >= 0;
                }

                static void unlockProject(int& lock)
                {
                    if (lock < 0)
                        return;
#ifdef _WIN32
                    _close(lock);
#else
                    ::close(lock);
#endif
                    lock = -1;
                }

                void reset()
                {
                    unlockProject(_extraLock);
                    unlockProject(_lock);
                    if (!_extraDirectory.empty())
                    {
                        std::error_code error;
                        if (std::filesystem::is_empty(_extraDirectory, error))
                            std::filesystem::remove(_extraDirectory, error);
                        if (error)
                            fray::log::engineError("Cannot clean up project directory: %s", error.message().c_str());
                        _extraDirectory.clear();
                    }
                    _archive.clear();
                    _workspace.clear();
                    _name.clear();
                    _archiveExists = false;
                }

                static bool unusedPath(const std::filesystem::path& parent, const std::string& stem,
                                       const std::string& extension, std::filesystem::path& output)
                {
                    std::error_code error;
                    for (unsigned i = 1; i < 100000; ++i)
                    {
                        const auto candidate = parent / (stem + "-" + std::to_string(i) + extension);
                        const bool exists = std::filesystem::exists(candidate, error);
                        if (error)
                        {
                            fray::log::engineError("Cannot inspect project path: %s", error.message().c_str());
                            return false;
                        }
                        if (!exists)
                        {
                            output = candidate;
                            return true;
                        }
                    }
                    fray::log::engineError("Cannot find an unused project path.");
                    return false;
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
                FileManager(const FileManager&) = delete;
                FileManager& operator=(const FileManager&) = delete;

                ~FileManager()
                {
                    if (_users != 0)
                        fray::log::engineError("File manager destroyed while state managers are still using it.");
                    _lifetime.reset();
                    reset();
                }

                bool isOpen() const { return !_workspace.empty(); }
                const std::string& projectName() const { return _name; }
                const std::filesystem::path& workingDirectory() const { return _workspace; }
                const std::filesystem::path& archivePath() const { return _archive; }

                F_err filePath(const std::string& name, std::filesystem::path& result) const
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

                F_err open(const std::string& path, ConflictChoice choice = ConflictChoice::Ask)
                {
                    if (isOpen() || path.empty() || path.find('\0') != std::string::npos)
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
                    const bool hasArchive = std::filesystem::exists(originalArchive, error);
                    if (error)
                    {
                        fray::log::engineError("Cannot inspect project archive: %s", error.message().c_str());
                        reset();
                        return fray::errors::FAILED_OPEN_PROJECT;
                    }
                    const bool hasFolder = std::filesystem::exists(originalFolder, error);
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
                    if (hasArchive && hasFolder && choice == ConflictChoice::Ask)
                    {
                        reset();
                        return fray::errors::PROJECT_CONFLICT;
                    }
                    if (!lockProject(originalArchive, _lock))
                    {
                        reset();
                        return fray::errors::FAILED_OPEN_PROJECT;
                    }
                    const bool useArchive = hasArchive && (!hasFolder || choice == ConflictChoice::Archive);
                    _archive = originalArchive;
                    _archiveExists = hasArchive;
                    _workspace = originalFolder;
                    if (hasArchive && hasFolder)
                    {
                        const std::string suffix = useArchive ? ".archive" : ".recovered";
                        std::filesystem::path extra;
                        if (!unusedPath(parent, _name + suffix, "", extra) ||
                            !std::filesystem::create_directory(extra, error))
                        {
                            fray::log::engineError("Cannot create separate project directory: %s", error.message().c_str());
                            reset();
                            return fray::errors::FAILED_OPEN_PROJECT;
                        }
                        _extraDirectory = extra;
                        if (!lockProject(extra / (_name + ".fry"), _extraLock))
                        {
                            reset();
                            return fray::errors::FAILED_OPEN_PROJECT;
                        }
                        if (useArchive)
                            _workspace = extra / _name;
                        else
                        {
                            _archive = extra / (_name + ".fry");
                            _archiveExists = false;
                        }
                    }
                    if (useArchive)
                    {
                        if (!extract())
                        {
                            reset();
                            return fray::errors::FAILED_OPEN_PROJECT;
                        }
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
                    reset();
                    return fray::errors::NONE;
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
                    const bool repository = std::filesystem::exists(_workspace / ".git", error);
                    if (error)
                    {
                        fray::log::engineError("Cannot check project folder safety: %s", error.message().c_str());
                        return fray::errors::FAILED_CLOSE_PROJECT;
                    }
                    if (protectedFolder || repository)
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
