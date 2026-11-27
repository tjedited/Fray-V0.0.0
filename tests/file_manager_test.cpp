#include "fray/fray_manager.hpp"

#include <sqlite3.h>
#include <zip.h>

#include <cassert>
#include <filesystem>
#include <fstream>
#include <iterator>
#include <stdexcept>
#include <string>

#ifndef _WIN32
#include <sys/wait.h>
#include <unistd.h>
#endif

namespace fs = std::filesystem;

static std::string readFile(const fs::path& path)
{
    std::ifstream input(path, std::ios::binary);
    assert(input.is_open());
    return std::string(std::istreambuf_iterator<char>(input), std::istreambuf_iterator<char>());
}

static void writeFile(const fs::path& path, const std::string& value)
{
    fs::create_directories(path.parent_path());
    std::ofstream output(path, std::ios::binary);
    output << value;
    output.close();
    assert(output.good());
}

static void createArchive(const fs::path& path, const char* name, const char* contents, bool symlink = false)
{
    int error = 0;
    zip_t* archive = zip_open(path.string().c_str(), ZIP_CREATE | ZIP_EXCL, &error);
    assert(archive != nullptr);
    zip_source_t* source = zip_source_buffer(archive, contents, std::char_traits<char>::length(contents), 0);
    assert(source != nullptr);
    const zip_int64_t index = zip_file_add(archive, name, source, ZIP_FL_ENC_UTF_8);
    assert(index >= 0);
    if (symlink)
        assert(zip_file_set_external_attributes(archive, index, 0, ZIP_OPSYS_UNIX, 0120777U << 16) == 0);
    assert(zip_close(archive) == 0);
}

static bool archiveHas(const fs::path& path, const char* name)
{
    int error = 0;
    zip_t* archive = zip_open(path.string().c_str(), ZIP_RDONLY | ZIP_CHECKCONS, &error);
    assert(archive != nullptr);
    const bool found = zip_name_locate(archive, name, 0) >= 0;
    zip_discard(archive);
    return found;
}

static int storedVersion(const fs::path& database)
{
    sqlite3* db = nullptr;
    sqlite3_stmt* statement = nullptr;
    assert(sqlite3_open_v2(database.string().c_str(), &db, SQLITE_OPEN_READONLY, nullptr) == SQLITE_OK);
    assert(sqlite3_prepare_v2(db,
        "SELECT value FROM fray_state_46726179 WHERE key = 'project.version.major'",
        -1, &statement, nullptr) == SQLITE_OK);
    assert(sqlite3_step(statement) == SQLITE_ROW);
    const int value = sqlite3_column_int(statement, 0);
    assert(sqlite3_finalize(statement) == SQLITE_OK);
    assert(sqlite3_close(db) == SQLITE_OK);
    return value;
}

int main(int argc, char** argv)
{
    assert(argc == 2);
    const fs::path root(argv[1]);
    const fs::path archive = root / "TestProject.fry";
    const fs::path folder = root / "TestProject";
    const fs::path database = folder / "TestProject.sqlite";
    const fs::path other = root / "OtherProject";
    const fs::path backup = root / "test-backup";

    {
        fray::FrayManager app("ExampleApplication");
        bool rejectedSecond = false;
        try { fray::FrayManager duplicate; }
        catch (const std::logic_error&) { rejectedSecond = true; }
        assert(rejectedSecond);

        assert(app.openProject(archive.string()).get() == fray::errors::NONE);
        assert(fs::is_regular_file(root / "TestProject.lock"));
        assert(!fs::exists(root / "TestProject.fry.lock"));
        fray::files::FileManager competingProject;
        assert(competingProject.open(folder.string()) == fray::errors::FAILED_OPEN_PROJECT);
        assert(app.openProject(archive.string()).get() == fray::errors::PROJECT_ALREADY_OPEN);
        auto& project = app.project("TestProject");
        assert(project.set("project.preferences.packageOnClose", true) == fray::errors::NONE);
        assert(project.name() == "TestProject");
        assert(project.applicationId() == "ExampleApplication");
        assert(fs::is_directory(folder) && fs::is_regular_file(database));
        assert(!fs::exists(archive));
        std::string name;
        assert(project.get("project.info.name", name) == fray::errors::NONE && name == "TestProject");
        assert(project.set("project.version.major", 0) == fray::errors::NONE);
        assert(project.set("project.version.minor", 1) == fray::errors::NONE);
        assert(storedVersion(database) == 0);
        assert(!fs::exists(archive));

        assert(project.openState("plugin") == fray::errors::NONE);
        assert(project.openState("plugin") == fray::errors::NONE);
        assert(project.openState("") == fray::errors::FAILED_OPEN_STORE);
        auto& plugin = project.state("plugin");
        assert(plugin.projectName() == "TestProject");
        assert(plugin.applicationId() == "ExampleApplication");
        assert(plugin.set("plugin.value", "preserved") == fray::errors::NONE);
        fs::path asset;
        assert(project.fileManager().filePath("plugins/example.txt", asset) == fray::errors::NONE);
        writeFile(asset, "plugin content");
        assert(project.fileManager().filePath("../outside", asset) == fray::errors::FAILED_OPEN_PROJECT);

        assert(app.openProject(other.string()).get() == fray::errors::NONE);
        assert(app.project("OtherProject").set("project.preferences.packageOnClose", true) == fray::errors::NONE);
        assert(app.project("OtherProject").set("project.version.major", 7) == fray::errors::NONE);
        const fs::path trailing = root / "Trailing";
        assert(fs::create_directory(trailing));
        assert(app.openProject(trailing.string() + "/").get() == fray::errors::NONE);
        assert(app.project("Trailing").name() == "Trailing");
        assert(app.project("Trailing").set("project.preferences.packageOnClose", true) == fray::errors::NONE);
        assert(app.closeProject("Trailing") == fray::errors::NONE);
        int version = -1;
        assert(project.get("project.version.major", version) == fray::errors::NONE && version == 0);
        fs::copy(folder, backup, fs::copy_options::recursive);
        assert(app.close() == fray::errors::NONE);
        assert(!fs::exists(root / "TestProject.lock") && !fs::exists(root / "OtherProject.lock"));
        assert(fs::exists(archive) && fs::exists(root / "OtherProject.fry"));
        assert(!fs::exists(folder) && !fs::exists(other) && !fs::exists(trailing));
        assert(archiveHas(archive, "TestProject.sqlite"));
        assert(archiveHas(archive, "plugins/example.txt"));
    }

    fs::copy(backup, folder, fs::copy_options::recursive);
    {
        writeFile(root / "TestProject-unselected-1" / "keep.txt", "keep folder");
        createArchive(root / "TestProject-unselected-2.fry", "keep.txt", "keep archive");
        fray::FrayManager app("ExampleApplication");
        assert(app.openProject(archive.string()).get() == fray::errors::PROJECT_CONFLICT);
        assert(app.openProject(archive.string(), fray::files::ConflictChoice::Folder).get() == fray::errors::NONE);
        auto& project = app.project("TestProject");
        const fs::path renamedArchive = root / "TestProject-unselected-3.fry";
        assert(!fs::exists(root / "TestProject-unselected-3.lock"));
        assert(!fs::exists(archive) && fs::exists(renamedArchive));
        assert(archiveHas(renamedArchive, "TestProject-unselected-3.sqlite"));
        assert(readFile(root / "TestProject-unselected-1" / "keep.txt") == "keep folder");
        assert(archiveHas(root / "TestProject-unselected-2.fry", "keep.txt"));
        assert(project.set("project.version.major", 9) == fray::errors::NONE);
        assert(storedVersion(database) == 9);
        assert(project.close() == fray::errors::NONE);
        assert(fs::exists(archive) && !fs::exists(folder));
        assert(app.closeProject("TestProject") == fray::errors::NONE);
        assert(app.openProject(renamedArchive.string()).get() == fray::errors::NONE);
        auto& renamedProject = app.project("TestProject-unselected-3");
        int version = -1;
        assert(renamedProject.get("project.version.major", version) == fray::errors::NONE && version == 0);
        assert(renamedProject.openState("plugin") == fray::errors::NONE);
        std::string value;
        assert(renamedProject.state("plugin").get("plugin.value", value) == fray::errors::NONE && value == "preserved");
        assert(renamedProject.close() == fray::errors::NONE);
        assert(app.closeProject("TestProject-unselected-3") == fray::errors::NONE);

        fs::copy(backup, folder, fs::copy_options::recursive);
        assert(app.openProject(archive.string()).get() == fray::errors::PROJECT_CONFLICT);
        assert(app.openProject(archive.string(), fray::files::ConflictChoice::Archive).get() == fray::errors::NONE);
        auto& fromArchive = app.project("TestProject");
        const fs::path archiveWorkspace = fromArchive.fileManager().workingDirectory();
        assert(archiveWorkspace.filename() == "TestProject");
        assert(archiveWorkspace.parent_path() == fs::canonical(root));
        const fs::path renamedFolder = root / "TestProject-unselected-4";
        assert(!fs::exists(root / "TestProject-unselected-4.lock"));
        assert(!fs::exists(root / "TestProject-unselected-4.fry.lock"));
        assert(storedVersion(renamedFolder / "TestProject-unselected-4.sqlite") == 0);
        fray::files::FileManager competingWorkspace;
        assert(competingWorkspace.open(archiveWorkspace.string(), fray::files::ConflictChoice::Archive) ==
               fray::errors::FAILED_OPEN_PROJECT);
        assert(readFile(fromArchive.fileManager().workingDirectory() / "plugins/example.txt") == "plugin content");
        assert(fromArchive.get("project.version.major", version) == fray::errors::NONE && version == 9);
        assert(fromArchive.openState("plugin") == fray::errors::NONE);
        assert(fromArchive.state("plugin").get("plugin.value", value) == fray::errors::NONE && value == "preserved");
        assert(fromArchive.set("project.version.major", 12) == fray::errors::NONE);
#ifndef _WIN32
        const fs::path link = fromArchive.fileManager().workingDirectory() / "outside-link";
        fs::create_symlink(root / "outside", link);
        // The .fry is replaced by a database snapshot while the project is open.
        assert(!fs::exists(archive));
        std::size_t snapshots = 0;
        for (const auto& entry : fs::directory_iterator(fromArchive.fileManager().workingDirectory() / "snapshots"))
            snapshots += entry.path().extension() == ".sqlite";
        assert(snapshots >= 1);
        assert(fromArchive.close() == fray::errors::FAILED_SAVE_PROJECT);
        assert(fs::is_regular_file(root / "TestProject.lock"));
        assert(!fs::exists(archive) && fs::is_directory(fromArchive.fileManager().workingDirectory()));
        assert(fs::remove(link));
#endif
        assert(fromArchive.close() == fray::errors::NONE);
        assert(storedVersion(renamedFolder / "TestProject-unselected-4.sqlite") == 0);
        assert(!fs::exists(archiveWorkspace));
        assert(archiveHas(archive, "plugins/example.txt"));
        assert(app.closeProject("TestProject") == fray::errors::NONE);
        assert(app.openProject(archive.string()).get() == fray::errors::NONE);
        auto& reopenedArchive = app.project("TestProject");
        assert(reopenedArchive.get("project.version.major", version) == fray::errors::NONE && version == 12);
        assert(reopenedArchive.close() == fray::errors::NONE);
        assert(app.closeProject("TestProject") == fray::errors::NONE);
        assert(app.openProject(renamedFolder.string()).get() == fray::errors::NONE);
        auto& renamedFolderProject = app.project("TestProject-unselected-4");
        assert(renamedFolderProject.get("project.version.major", version) == fray::errors::NONE && version == 0);
        assert(renamedFolderProject.set("project.preferences.packageOnClose", false) == fray::errors::NONE);
        assert(renamedFolderProject.close() == fray::errors::NONE);
        assert(fs::is_directory(renamedFolder) && !fs::exists(root / "TestProject-unselected-4.fry"));
    }

    {
        fray::files::FileManager files;
        fray::files::FileManager competing;
        const fs::path path = root / "Project.v1.fry";
        assert(files.open(path.string()) == fray::errors::NONE);
        assert(fs::is_regular_file(root / "Project.v1.lock"));
        assert(!fs::exists(root / "Project.v1.fry.lock"));
        assert(competing.open((root / "Project.v1").string()) == fray::errors::FAILED_OPEN_PROJECT);
        assert(files.close() == fray::errors::NONE);
        assert(!fs::exists(root / "Project.v1.lock"));
    }

    {
        const fs::path archive = root / "StaleLock.fry";
        const fs::path lock = root / "StaleLock.lock";
        writeFile(lock, "");
        fray::files::FileManager files;
        fray::files::FileManager competing;
        assert(files.open(archive.string()) == fray::errors::NONE);
        assert(competing.open(archive.string()) == fray::errors::FAILED_OPEN_PROJECT);
        assert(fs::is_regular_file(lock));
        assert(files.close() == fray::errors::NONE);
        assert(!fs::exists(lock));
    }

    {
        const fs::path lock = root / "Occupied.lock";
        writeFile(lock, "do not remove");
        fray::files::FileManager files;
        assert(files.open((root / "Occupied.fry").string()) == fray::errors::FAILED_OPEN_PROJECT);
        assert(readFile(lock) == "do not remove");
    }

#ifndef _WIN32
    {
        const fs::path folder = root / "Concurrent";
        const fs::path guard = root / "concurrent-guard";
        assert(fs::create_directory(folder));
        pid_t children[4];
        for (auto& child : children)
        {
            child = fork();
            assert(child >= 0);
            if (child == 0)
            {
                for (int i = 0; i < 100; ++i)
                {
                    fray::files::FileManager files;
                    if (files.open(folder.string()) != fray::errors::NONE)
                        continue;
                    std::error_code error;
                    if (!fs::create_directory(guard, error) || error)
                        _exit(1);
                    usleep(1000);
                    if (!fs::remove(guard, error) || error || files.close() != fray::errors::NONE)
                        _exit(1);
                }
                _exit(0);
            }
        }
        for (pid_t child : children)
        {
            int status = 0;
            assert(waitpid(child, &status, 0) == child);
            assert(WIFEXITED(status) && WEXITSTATUS(status) == 0);
        }
        assert(!fs::exists(root / "Concurrent.lock"));
    }

    if (geteuid() != 0)
    {
        const fs::path parent = root / "LockCleanup";
        const fs::path folder = parent / "Project";
        assert(fs::create_directories(folder));
        fray::files::FileManager files;
        assert(files.open(folder.string()) == fray::errors::NONE);
        fs::permissions(parent, fs::perms::owner_read | fs::perms::owner_exec);
        assert(files.close() == fray::errors::FAILED_CLOSE_PROJECT);
        assert(fs::exists(parent / "Project.lock"));
        fs::permissions(parent, fs::perms::owner_all);
        assert(files.close() == fray::errors::NONE);
        assert(!fs::exists(parent / "Project.lock"));
    }
#endif

    {
        const fs::path path = root / "EmptyFolder.fry";
        const fs::path folder = root / "EmptyFolder";
        createArchive(path, "asset.txt", "archive");
        assert(fs::create_directory(folder));
        fray::files::FileManager files;
        assert(files.open(path.string(), fray::files::ConflictChoice::Archive) == fray::errors::NONE);
        assert(fs::is_empty(root / "EmptyFolder-unselected-1"));
        assert(readFile(folder / "asset.txt") == "archive");
        assert(files.close() == fray::errors::NONE);
    }

    {
        const fs::path path = root / "InvalidArchive.fry";
        writeFile(path, "not a zip");
        writeFile(root / "InvalidArchive" / "asset.txt", "folder");
        fray::files::FileManager files;
        assert(files.open(path.string(), fray::files::ConflictChoice::Folder) == fray::errors::NONE);
        assert(readFile(root / "InvalidArchive-unselected-1.fry") == "not a zip");
        assert(readFile(root / "InvalidArchive" / "asset.txt") == "folder");
        assert(files.close() == fray::errors::NONE);
    }

    {
        const fs::path path = root / "NoDatabase.fry";
        const fs::path folder = root / "NoDatabase";
        createArchive(path, "NoDatabase-unselected-1.sqlite", "keep");
        writeFile(folder / "keep.txt", "folder");
        const std::string original = readFile(path);
        fray::files::FileManager files;
        assert(files.open(path.string(), fray::files::ConflictChoice::Folder) == fray::errors::NONE);
        assert(readFile(root / "NoDatabase-unselected-1.fry") == original);
        assert(files.close() == fray::errors::NONE);
    }

    {
        const fs::path path = root / "Unpackaged.fry";
        const fs::path workspace = root / "Unpackaged";
        fray::FrayManager app;
        assert(app.openProject(path.string()).get() == fray::errors::NONE);
        auto& project = app.project("Unpackaged");
        assert(project.set("project.preferences.packageOnClose", false) == fray::errors::NONE);
        assert(project.set("project.version.major", 42) == fray::errors::NONE);
        assert(project.close() == fray::errors::NONE);
        assert(fs::is_directory(workspace) && !fs::exists(path));
        assert(app.closeProject("Unpackaged") == fray::errors::NONE);
        assert(app.openProject(workspace.string()).get() == fray::errors::NONE);
        auto& reopened = app.project("Unpackaged");
        bool package = true;
        int version = 0;
        assert(reopened.get("project.preferences.packageOnClose", package) == fray::errors::NONE && !package);
        assert(reopened.get("project.version.major", version) == fray::errors::NONE && version == 42);
        assert(reopened.set("project.preferences.packageOnClose", true) == fray::errors::NONE);
        assert(reopened.close() == fray::errors::NONE);
        assert(!fs::exists(workspace) && archiveHas(path, "Unpackaged.sqlite"));
        assert(app.closeProject("Unpackaged") == fray::errors::NONE);
        const std::string saved = readFile(path);
        assert(app.openProject(path.string()).get() == fray::errors::NONE);
        auto& extracted = app.project("Unpackaged");
        assert(extracted.set("project.preferences.packageOnClose", false) == fray::errors::NONE);
        assert(extracted.set("project.version.major", 43) == fray::errors::NONE);
        assert(extracted.close() == fray::errors::NONE);
        assert(fs::is_directory(workspace) && !fs::exists(path));
        assert(std::distance(fs::directory_iterator(workspace / "snapshots"), fs::directory_iterator()) >= 1);
        assert(app.closeProject("Unpackaged") == fray::errors::NONE);
        assert(app.openProject(path.string()).get() == fray::errors::NONE);
        assert(app.project("Unpackaged").set("project.preferences.packageOnClose", true) == fray::errors::NONE);
        assert(app.closeProject("Unpackaged") == fray::errors::NONE);
        assert(fs::exists(path) && !fs::exists(workspace));
    }

    {
        fray::FrayManager app;
        const fs::path path = root / "InvalidPreference.fry";
        assert(app.openProject(path.string()).get() == fray::errors::NONE);
        auto& project = app.project("InvalidPreference");
        assert(project.set("project.preferences.packageOnClose", "not a boolean") == fray::errors::NONE);
        assert(project.close() == fray::errors::FAILED_CLOSE_PROJECT);
        assert(!fs::exists(path) && fs::is_directory(root / "InvalidPreference"));
        assert(project.set("project.preferences.packageOnClose", false) == fray::errors::NONE);
        assert(project.close() == fray::errors::NONE);
    }

    {
        const fs::path path = root / "Collision.fry";
        const fs::path workspace = root / "Collision";
        createArchive(path, "asset.txt", "archive");
        const std::string saved = readFile(path);
        writeFile(workspace / "Collision.sqlite", "original");
        writeFile(workspace / "Collision-unselected-1.sqlite", "other");
        fray::files::FileManager files;
        assert(files.open(path.string(), fray::files::ConflictChoice::Archive) == fray::errors::FAILED_OPEN_PROJECT);
        assert(readFile(path) == saved && readFile(workspace / "Collision.sqlite") == "original");
        assert(readFile(workspace / "Collision-unselected-1.sqlite") == "other" && !fs::exists(root / "Collision-unselected-1"));
        assert(!fs::exists(root / "Collision.lock") && !fs::exists(root / "Collision-unselected-1.lock"));
    }

    {
        const fs::path path = root / "Sidecars.fry";
        const fs::path workspace = root / "Sidecars";
        createArchive(path, "asset.txt", "archive");
        writeFile(workspace / "Sidecars.sqlite", "database");
        writeFile(workspace / "Sidecars.sqlite-wal", "wal");
        writeFile(workspace / "Sidecars.sqlite-shm", "shm");
        writeFile(workspace / "Sidecars.sqlite-journal", "journal");
        fray::files::FileManager files;
        assert(files.open(path.string(), fray::files::ConflictChoice::Archive) == fray::errors::NONE);
        const fs::path renamed = root / "Sidecars-unselected-1";
        assert(readFile(renamed / "Sidecars-unselected-1.sqlite") == "database");
        assert(readFile(renamed / "Sidecars-unselected-1.sqlite-wal") == "wal");
        assert(readFile(renamed / "Sidecars-unselected-1.sqlite-shm") == "shm");
        assert(readFile(renamed / "Sidecars-unselected-1.sqlite-journal") == "journal");
        assert(files.close() == fray::errors::NONE);
    }

    {
        const fs::path path = root / "ArchiveCollision.fry";
        const fs::path workspace = root / "ArchiveCollision";
        int error = 0;
        zip_t* zip = zip_open(path.string().c_str(), ZIP_CREATE | ZIP_EXCL, &error);
        assert(zip != nullptr);
        for (const char* name : {"ArchiveCollision.sqlite", "ArchiveCollision-unselected-1.sqlite"})
        {
            zip_source_t* source = zip_source_buffer(zip, "data", 4, 0);
            assert(source != nullptr && zip_file_add(zip, name, source, ZIP_FL_ENC_UTF_8) >= 0);
        }
        assert(zip_close(zip) == 0);
        const std::string saved = readFile(path);
        writeFile(workspace / "keep.txt", "folder");
        fray::files::FileManager files;
        assert(files.open(path.string(), fray::files::ConflictChoice::Folder) == fray::errors::FAILED_OPEN_PROJECT);
        assert(readFile(path) == saved && readFile(workspace / "keep.txt") == "folder");
        assert(!fs::exists(root / "ArchiveCollision-unselected-1.fry"));
    }

    {
        const fs::path path = root / "ArchiveSidecars.fry";
        const fs::path workspace = root / "ArchiveSidecars";
        int error = 0;
        zip_t* zip = zip_open(path.string().c_str(), ZIP_CREATE | ZIP_EXCL, &error);
        assert(zip != nullptr);
        for (const char* name : {"ArchiveSidecars.sqlite", "ArchiveSidecars.sqlite-wal",
                                 "ArchiveSidecars.sqlite-shm", "ArchiveSidecars.sqlite-journal"})
        {
            zip_source_t* source = zip_source_buffer(zip, "data", 4, 0);
            assert(source != nullptr && zip_file_add(zip, name, source, ZIP_FL_ENC_UTF_8) >= 0);
        }
        assert(zip_close(zip) == 0);
        writeFile(workspace / "keep.txt", "folder");
        fray::files::FileManager files;
        assert(files.open(path.string(), fray::files::ConflictChoice::Folder) == fray::errors::NONE);
        const fs::path renamed = root / "ArchiveSidecars-unselected-1.fry";
        assert(archiveHas(renamed, "ArchiveSidecars-unselected-1.sqlite"));
        assert(archiveHas(renamed, "ArchiveSidecars-unselected-1.sqlite-wal"));
        assert(archiveHas(renamed, "ArchiveSidecars-unselected-1.sqlite-shm"));
        assert(archiveHas(renamed, "ArchiveSidecars-unselected-1.sqlite-journal"));
        assert(!archiveHas(renamed, "ArchiveSidecars.sqlite"));
        assert(files.close() == fray::errors::NONE);
    }

    {
        const fs::path missing = root / "Missing.fry";
        createArchive(missing, "asset.txt", "keep");
        fray::FrayManager app;
        assert(app.openProject(missing.string()).get() == fray::errors::NONE);
        auto& project = app.project("Missing");
        assert(project.set("project.preferences.packageOnClose", true) == fray::errors::NONE);
        assert(fs::exists(root / "Missing" / "Missing.sqlite"));
        assert(readFile(root / "Missing" / "asset.txt") == "keep");
        assert(project.close() == fray::errors::NONE);
        assert(!fs::exists(root / "Missing"));
        assert(archiveHas(missing, "Missing.sqlite") && archiveHas(missing, "asset.txt"));
    }

    {
        const fs::path unsafe = root / "Unsafe.fry";
        createArchive(unsafe, "../escape.txt", "unsafe");
        fray::FrayManager app;
        assert(app.openProject(unsafe.string()).get() == fray::errors::FAILED_OPEN_PROJECT);
        assert(!fs::exists(root / "escape.txt") && !fs::exists(root / "Unsafe"));
        assert(!fs::exists(root / "Unsafe.lock"));
        assert(archiveHas(unsafe, "../escape.txt"));
    }

    {
        const fs::path unsafe = root / "Symlink.fry";
        createArchive(unsafe, "link", "target", true);
        fray::FrayManager app;
        assert(app.openProject(unsafe.string()).get() == fray::errors::FAILED_OPEN_PROJECT);
        assert(!fs::exists(root / "Symlink"));
    }

    {
        const fs::path broken = root / "Broken";
        writeFile(broken / "Broken.sqlite", "not a database");
        fray::FrayManager app;
        assert(app.openProject(broken.string()).get() == fray::errors::FAILED_OPEN_STORE);
        assert(readFile(broken / "Broken.sqlite") == "not a database");
        assert(!fs::exists(root / "Broken.fry"));
    }

    {
        const fs::path race = root / "Race.fry";
        fray::FrayManager app;
        assert(app.openProject(race.string()).get() == fray::errors::NONE);
        auto& project = app.project("Race");
        assert(project.set("project.preferences.packageOnClose", true) == fray::errors::NONE);
        createArchive(race, "external.txt", "keep");
        const std::string external = readFile(race);
        assert(project.close() == fray::errors::FAILED_SAVE_PROJECT);
        assert(readFile(race) == external);
        assert(fs::exists(project.fileManager().workingDirectory() / "Race.sqlite"));
        assert(fs::remove(race));
        assert(project.close() == fray::errors::NONE);
        assert(!fs::exists(root / "Race"));
    }

    {
        const fs::path protectedFolder = root / "Protected";
        assert(fs::create_directory(protectedFolder));
        const fs::path previous = fs::current_path();
        fs::current_path(protectedFolder);
        {
            fray::FrayManager app;
            assert(app.openProject(protectedFolder.string()).get() == fray::errors::NONE);
            assert(app.project("Protected").set("project.preferences.packageOnClose", true) == fray::errors::NONE);
            assert(app.project("Protected").close() == fray::errors::FAILED_CLOSE_PROJECT);
            assert(fs::exists(root / "Protected.fry") && fs::is_directory(protectedFolder));
        }
        fs::current_path(previous);
    }

    {
        const fs::path repository = root / "Repository";
        writeFile(repository / ".git" / "config", "keep");
        fray::FrayManager app;
        assert(app.openProject(repository.string()).get() == fray::errors::NONE);
        assert(app.project("Repository").set("project.preferences.packageOnClose", true) == fray::errors::NONE);
        assert(app.project("Repository").close() == fray::errors::NONE);
        assert(!fs::exists(repository));
        assert(archiveHas(root / "Repository.fry", ".git/config"));
    }

#ifndef _WIN32
    {
        const fs::path linkProject = root / "LinkProject.fry";
        fray::FrayManager app;
        assert(app.openProject(linkProject.string()).get() == fray::errors::NONE);
        auto& project = app.project("LinkProject");
        assert(project.set("project.preferences.packageOnClose", true) == fray::errors::NONE);
        const fs::path link = project.fileManager().workingDirectory() / "link";
        fs::create_symlink(root / "outside", link);
        assert(project.close() == fray::errors::FAILED_SAVE_PROJECT);
        assert(!fs::exists(linkProject) && fs::exists(project.fileManager().workingDirectory()));
        assert(fs::remove(link));
        assert(project.close() == fray::errors::NONE);
        assert(!fs::exists(root / "LinkProject"));
        assert(archiveHas(linkProject, "LinkProject.sqlite"));
    }

    if (geteuid() != 0)
    {
        const fs::path cleanup = root / "Cleanup.fry";
        const fs::path workspace = root / "Cleanup";
        fray::FrayManager app;
        assert(app.openProject(cleanup.string()).get() == fray::errors::NONE);
        auto& project = app.project("Cleanup");
        assert(project.set("project.preferences.packageOnClose", true) == fray::errors::NONE);
        assert(project.set("value", 42) == fray::errors::NONE);
        fs::permissions(workspace, fs::perms::owner_read | fs::perms::owner_exec);
        assert(project.close() == fray::errors::FAILED_CLOSE_PROJECT);
        assert(fs::exists(cleanup) && fs::exists(workspace));
        const std::string saved = readFile(cleanup);
        assert(project.openState("plugin") == fray::errors::FAILED_OPEN_STORE);
        fs::permissions(workspace, fs::perms::owner_all);
        assert(project.close() == fray::errors::NONE);
        assert(!fs::exists(workspace) && readFile(cleanup) == saved);
        assert(app.openProject(cleanup.string()).get() == fray::errors::NONE);
        int value = 0;
        assert(app.project("Cleanup").get("value", value) == fray::errors::NONE && value == 42);
        assert(app.project("Cleanup").close() == fray::errors::NONE);
    }
#endif

    {
        fray::FrayManager app;
        const fs::path automatic = root / "Automatic.fry";
        assert(app.openProject(automatic.string()).get() == fray::errors::NONE);
        assert(app.project("Automatic").set("value", 42) == fray::errors::NONE);
    }
    assert(!fs::exists(root / "Automatic.fry"));
    assert(fs::is_regular_file(root / "Automatic" / "Automatic.sqlite"));
    assert(!fs::exists(root / "Automatic.lock"));
}
