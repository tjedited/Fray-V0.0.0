#ifndef FRAY_FILE_MANAGER_HPP
#define FRAY_FILE_MANAGER_HPP

#include <filesystem>
#include <fstream>
#include <memory>
#include <random>
#include <string>
#include <system_error>

#include <sqlite3.h>
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

namespace fray
{
    namespace files
    {
        class FileManager
        {
            private:
                friend class fray::state::StateManager;
                std::filesystem::path _archive;
                std::filesystem::path _workspace;
                int _lock = -1;
                unsigned _users = 0;
                bool _dirty = false;
                std::shared_ptr<int> _lifetime = std::make_shared<int>(0);

                bool lockProject()
                {
                    const std::string path = _archive.string() + ".lock";
#ifdef _WIN32
                    if (_sopen_s(&_lock, path.c_str(), _O_CREAT | _O_RDWR | _O_BINARY,
                                 _SH_DENYRW, _S_IREAD | _S_IWRITE) != 0)
                        _lock = -1;
#else
                    _lock = ::open(path.c_str(), O_CREAT | O_RDWR | O_NOFOLLOW, 0600);
                    if (_lock >= 0 && flock(_lock, LOCK_EX | LOCK_NB) != 0)
                    {
                        ::close(_lock);
                        _lock = -1;
                    }
#endif
                    if (_lock < 0)
                        fray::log::engineError("Cannot lock project: %s", path.c_str());
                    return _lock >= 0;
                }

                void unlockProject()
                {
                    if (_lock < 0)
                        return;
#ifdef _WIN32
                    _close(_lock);
#else
                    ::close(_lock);
#endif
                    _lock = -1;
                }

                bool createWorkspace()
                {
                    std::error_code error;
                    const auto root = std::filesystem::temp_directory_path(error);
                    if (error)
                    {
                        fray::log::engineError("Cannot locate temporary directory: %s", error.message().c_str());
                        return false;
                    }
                    std::random_device random;
                    for (int i = 0; i < 32; ++i)
                    {
                        const auto candidate = root / ("fray-" + std::to_string(random()) + "-" + std::to_string(random()));
                        if (std::filesystem::create_directory(candidate, error))
                        {
                            _workspace = candidate;
                            std::filesystem::permissions(candidate, std::filesystem::perms::owner_all,
                                                         std::filesystem::perm_options::replace, error);
                            if (!error)
                                return true;
                            fray::log::engineError("Cannot protect project workspace: %s", error.message().c_str());
                            return false;
                        }
                        if (error && error != std::errc::file_exists)
                            break;
                        error.clear();
                    }
                    fray::log::engineError("Cannot create project workspace: %s", error.message().c_str());
                    return false;
                }

                bool cleanup()
                {
                    bool success = true;
                    if (!_workspace.empty())
                    {
                        if (_dirty)
                            fray::log::engineError("Unsaved project data retained at %s.", _workspace.string().c_str());
                        else
                        {
                            std::error_code error;
                            std::filesystem::remove_all(_workspace, error);
                            if (error)
                            {
                                fray::log::engineError("Cannot remove project workspace: %s", error.message().c_str());
                                success = false;
                            }
                        }
                        _workspace.clear();
                    }
                    unlockProject();
                    _archive.clear();
                    return success;
                }

                bool extractDatabase()
                {
                    int error = 0;
                    zip_t* archive = zip_open(_archive.string().c_str(), ZIP_RDONLY | ZIP_CHECKCONS, &error);
                    if (!archive)
                    {
                        fray::log::engineError("Cannot open project archive (zip error %d).", error);
                        return false;
                    }
                    const zip_int64_t index = zip_name_locate(archive, "state.sqlite", 0);
                    zip_file_t* entry = index < 0 ? nullptr : zip_fopen_index(archive, index, 0);
                    if (!entry)
                    {
                        fray::log::engineError("Project archive has no readable state.sqlite: %s", zip_strerror(archive));
                        zip_discard(archive);
                        return false;
                    }
                    std::ofstream output(databasePath(), std::ios::binary | std::ios::trunc);
                    char buffer[65536];
                    zip_int64_t count;
                    while (output && (count = zip_fread(entry, buffer, sizeof(buffer))) > 0)
                        output.write(buffer, count);
                    if (!output)
                        count = -1;
                    output.close();
                    const int entryResult = zip_fclose(entry);
                    zip_discard(archive);
                    if (count < 0 || !output || entryResult != 0)
                    {
                        fray::log::engineError("Cannot extract project database.");
                        return false;
                    }
                    return true;
                }

                bool snapshot()
                {
                    sqlite3* source = nullptr;
                    sqlite3* destination = nullptr;
                    const std::string input = databasePath();
                    const std::string output = (_workspace / "snapshot.sqlite").string();
                    int result = sqlite3_open_v2(input.c_str(), &source, SQLITE_OPEN_READONLY, nullptr);
                    if (result == SQLITE_OK)
                        result = sqlite3_open_v2(output.c_str(), &destination, SQLITE_OPEN_READWRITE | SQLITE_OPEN_CREATE, nullptr);
                    sqlite3_backup* backup = result == SQLITE_OK ? sqlite3_backup_init(destination, "main", source, "main") : nullptr;
                    if (result == SQLITE_OK && backup == nullptr)
                        result = sqlite3_errcode(destination);
                    if (backup != nullptr)
                    {
                        result = sqlite3_backup_step(backup, -1);
                        const int finished = sqlite3_backup_finish(backup);
                        if (result == SQLITE_DONE)
                            result = finished;
                    }
                    if (result != SQLITE_OK)
                        fray::log::engineError("Cannot snapshot project database: %s", sqlite3_errstr(result));
                    if (destination != nullptr && sqlite3_close(destination) != SQLITE_OK)
                    {
                        fray::log::engineError("Cannot close project snapshot database.");
                        result = SQLITE_ERROR;
                    }
                    if (source != nullptr && sqlite3_close(source) != SQLITE_OK)
                    {
                        fray::log::engineError("Cannot close project source database.");
                        result = SQLITE_ERROR;
                    }
                    return result == SQLITE_OK;
                }

            public:
                FileManager() = default;
                FileManager(const FileManager&) = delete;
                FileManager& operator=(const FileManager&) = delete;

                ~FileManager()
                {
                    if (_users != 0)
                    {
                        fray::log::engineError("File manager destroyed while state managers are still using it.");
                        _dirty = true;
                    }
                    _lifetime.reset();
                    cleanup();
                }

            private:
                std::string databasePath() const { return (_workspace / "state.sqlite").string(); }
                bool isOpen() const { return !_archive.empty() && !_workspace.empty(); }
                void attach() { ++_users; }
                void detach() { --_users; }
                std::weak_ptr<int> lifetime() const { return _lifetime; }

            public:
                F_err open(const std::string& path)
                {
                    if (isOpen() || path.empty() || path.find('\0') != std::string::npos ||
                        std::filesystem::path(path).extension() != ".fry")
                    {
                        fray::log::engineError("Cannot open project: invalid .fry path or project already open.");
                        return fray::errors::FAILED_OPEN_PROJECT;
                    }
                    std::error_code error;
                    _archive = std::filesystem::weakly_canonical(path, error);
                    if (error)
                        fray::log::engineError("Cannot resolve project path: %s", error.message().c_str());
                    if (error || !lockProject() || !createWorkspace())
                    {
                        cleanup();
                        return fray::errors::FAILED_OPEN_PROJECT;
                    }
                    const bool exists = std::filesystem::exists(_archive, error);
                    if (error)
                    {
                        fray::log::engineError("Cannot inspect project: %s", error.message().c_str());
                        cleanup();
                        return fray::errors::FAILED_OPEN_PROJECT;
                    }
                    if (exists)
                    {
                        if (!extractDatabase())
                        {
                            cleanup();
                            return fray::errors::FAILED_OPEN_PROJECT;
                        }
                    }
                    else
                    {
                        sqlite3* db = nullptr;
                        int result = sqlite3_open(databasePath().c_str(), &db);
                        if (result != SQLITE_OK)
                            fray::log::engineError("Cannot create project database: %s", sqlite3_errstr(result));
                        if (db != nullptr && sqlite3_close(db) != SQLITE_OK)
                        {
                            fray::log::engineError("Cannot close new project database.");
                            result = SQLITE_ERROR;
                        }
                        if (result != SQLITE_OK || saveArchive(true) != fray::errors::NONE)
                        {
                            cleanup();
                            return fray::errors::FAILED_OPEN_PROJECT;
                        }
                    }
                    return fray::errors::NONE;
                }

            private:
                F_err saveArchive(bool create)
                {
                    if (!isOpen())
                    {
                        fray::log::engineError("Cannot save project: no project is open.");
                        return fray::errors::FAILED_SAVE_PROJECT;
                    }
                    _dirty = true;
                    if (!snapshot())
                        return fray::errors::FAILED_SAVE_PROJECT;
                    int error = 0;
                    zip_t* archive = zip_open(_archive.string().c_str(), create ? ZIP_CREATE | ZIP_EXCL : 0, &error);
                    if (!archive)
                    {
                        fray::log::engineError("Cannot open project for saving (zip error %d).", error);
                        return fray::errors::FAILED_SAVE_PROJECT;
                    }
                    const std::string snapshotPath = (_workspace / "snapshot.sqlite").string();
                    zip_source_t* source = zip_source_file(archive, snapshotPath.c_str(), 0, -1);
                    if (source == nullptr)
                    {
                        fray::log::engineError("Cannot prepare project database: %s", zip_strerror(archive));
                        zip_discard(archive);
                        return fray::errors::FAILED_SAVE_PROJECT;
                    }
                    if (zip_file_add(archive, "state.sqlite", source, ZIP_FL_OVERWRITE | ZIP_FL_ENC_UTF_8) < 0)
                    {
                        fray::log::engineError("Cannot update project database: %s", zip_strerror(archive));
                        zip_source_free(source);
                        zip_discard(archive);
                        return fray::errors::FAILED_SAVE_PROJECT;
                    }
                    if (zip_close(archive) != 0)
                    {
                        fray::log::engineError("Cannot save project archive: %s", zip_strerror(archive));
                        zip_discard(archive);
                        return fray::errors::FAILED_SAVE_PROJECT;
                    }
                    _dirty = false;
                    return fray::errors::NONE;
                }

            public:
                F_err save() { return saveArchive(false); }

                F_err close()
                {
                    if (!isOpen() || _users != 0 || _dirty)
                    {
                        fray::log::engineError("Cannot close project: not open, still in use, or has unsaved changes.");
                        return fray::errors::FAILED_CLOSE_PROJECT;
                    }
                    return cleanup() ? fray::errors::NONE : fray::errors::FAILED_CLOSE_PROJECT;
                }
        };
    }
}

#endif
