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

        assert(app.openProject(archive.string()) == fray::errors::NONE);
        assert(app.openProject(archive.string()) == fray::errors::PROJECT_ALREADY_OPEN);
        auto& project = app.project("TestProject");
        assert(project.name() == "TestProject");
        assert(project.applicationId() == "ExampleApplication");
        assert(fs::is_directory(folder) && fs::is_regular_file(database));
        assert(!fs::exists(archive));
        std::string name;
        assert(project.get("project.name", name) == fray::errors::NONE && name == "TestProject");
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

        assert(app.openProject(other.string()) == fray::errors::NONE);
        assert(app.project("OtherProject").set("project.version.major", 7) == fray::errors::NONE);
        const fs::path trailing = root / "Trailing";
        assert(fs::create_directory(trailing));
        assert(app.openProject(trailing.string() + "/") == fray::errors::NONE);
        assert(app.project("Trailing").name() == "Trailing");
        assert(app.closeProject("Trailing") == fray::errors::NONE);
        int version = -1;
        assert(project.get("project.version.major", version) == fray::errors::NONE && version == 0);
        fs::copy(folder, backup, fs::copy_options::recursive);
        assert(app.close() == fray::errors::NONE);
        assert(fs::exists(archive) && fs::exists(root / "OtherProject.fry"));
        assert(!fs::exists(folder) && !fs::exists(other) && !fs::exists(trailing));
        assert(archiveHas(archive, "TestProject.sqlite"));
        assert(archiveHas(archive, "plugins/example.txt"));
    }

    const std::string original = readFile(archive);
    fs::copy(backup, folder, fs::copy_options::recursive);
    {
        fray::FrayManager app("ExampleApplication");
        assert(app.openProject(archive.string()) == fray::errors::PROJECT_CONFLICT);
        assert(app.openProject(archive.string(), fray::files::ConflictChoice::Folder) == fray::errors::NONE);
        auto& project = app.project("TestProject");
        const fs::path recovered = project.fileManager().archivePath();
        assert(recovered != archive && !fs::exists(recovered));
        assert(recovered.filename() == "TestProject.fry");
        fray::files::FileManager competingRecovery;
        assert(competingRecovery.open(recovered.string()) == fray::errors::FAILED_OPEN_PROJECT);
        assert(project.set("project.version.major", 9) == fray::errors::NONE);
        assert(storedVersion(database) == 9);
        assert(project.close() == fray::errors::NONE);
        assert(fs::exists(recovered) && readFile(archive) == original && !fs::exists(folder));
        assert(archiveHas(recovered, "plugins/example.txt"));
        assert(app.closeProject("TestProject") == fray::errors::NONE);
        assert(app.openProject(recovered.string()) == fray::errors::NONE);
        auto& recoveredProject = app.project("TestProject");
        int recoveredVersion = -1;
        assert(recoveredProject.get("project.version.major", recoveredVersion) == fray::errors::NONE &&
               recoveredVersion == 9);
        assert(recoveredProject.openState("plugin") == fray::errors::NONE);
        std::string recoveredValue;
        assert(recoveredProject.state("plugin").get("plugin.value", recoveredValue) == fray::errors::NONE &&
               recoveredValue == "preserved");
        fs::copy(recoveredProject.fileManager().workingDirectory(), folder, fs::copy_options::recursive);
        assert(recoveredProject.close() == fray::errors::NONE);
        assert(app.closeProject("TestProject") == fray::errors::NONE);

        assert(app.openProject(archive.string()) == fray::errors::PROJECT_CONFLICT);
        assert(app.openProject(archive.string(), fray::files::ConflictChoice::Archive) == fray::errors::NONE);
        auto& fromArchive = app.project("TestProject");
        assert(fromArchive.fileManager().workingDirectory() != folder);
        const fs::path archiveWorkspace = fromArchive.fileManager().workingDirectory();
        assert(archiveWorkspace.filename() == "TestProject");
        fray::files::FileManager competingWorkspace;
        assert(competingWorkspace.open(archiveWorkspace.string()) == fray::errors::FAILED_OPEN_PROJECT);
        assert(readFile(fromArchive.fileManager().workingDirectory() / "plugins/example.txt") == "plugin content");
        int version = -1;
        assert(fromArchive.get("project.version.major", version) == fray::errors::NONE && version == 0);
        assert(fromArchive.openState("plugin") == fray::errors::NONE);
        std::string value;
        assert(fromArchive.state("plugin").get("plugin.value", value) == fray::errors::NONE && value == "preserved");
#ifndef _WIN32
        const fs::path link = fromArchive.fileManager().workingDirectory() / "outside-link";
        fs::create_symlink(root / "outside", link);
        assert(fromArchive.close() == fray::errors::FAILED_SAVE_PROJECT);
        assert(readFile(archive) == original);
        assert(fs::remove(link));
#endif
        assert(fromArchive.close() == fray::errors::NONE);
        assert(storedVersion(database) == 9);
        assert(!fs::exists(archiveWorkspace));
        assert(app.closeProject("TestProject") == fray::errors::NONE);
    }

    {
        const fs::path missing = root / "Missing.fry";
        createArchive(missing, "asset.txt", "keep");
        fray::FrayManager app;
        assert(app.openProject(missing.string()) == fray::errors::NONE);
        auto& project = app.project("Missing");
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
        assert(app.openProject(unsafe.string()) == fray::errors::FAILED_OPEN_PROJECT);
        assert(!fs::exists(root / "escape.txt") && !fs::exists(root / "Unsafe"));
        assert(archiveHas(unsafe, "../escape.txt"));
    }

    {
        const fs::path unsafe = root / "Symlink.fry";
        createArchive(unsafe, "link", "target", true);
        fray::FrayManager app;
        assert(app.openProject(unsafe.string()) == fray::errors::FAILED_OPEN_PROJECT);
        assert(!fs::exists(root / "Symlink"));
    }

    {
        const fs::path broken = root / "Broken";
        writeFile(broken / "Broken.sqlite", "not a database");
        fray::FrayManager app;
        assert(app.openProject(broken.string()) == fray::errors::FAILED_OPEN_STORE);
        assert(readFile(broken / "Broken.sqlite") == "not a database");
        assert(!fs::exists(root / "Broken.fry"));
    }

    {
        const fs::path race = root / "Race.fry";
        fray::FrayManager app;
        assert(app.openProject(race.string()) == fray::errors::NONE);
        auto& project = app.project("Race");
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
            assert(app.openProject(protectedFolder.string()) == fray::errors::NONE);
            assert(app.project("Protected").close() == fray::errors::FAILED_CLOSE_PROJECT);
            assert(fs::exists(root / "Protected.fry") && fs::is_directory(protectedFolder));
        }
        fs::current_path(previous);
    }

    {
        const fs::path repository = root / "Repository";
        writeFile(repository / ".git" / "config", "keep");
        fray::FrayManager app;
        assert(app.openProject(repository.string()) == fray::errors::NONE);
        assert(app.project("Repository").close() == fray::errors::FAILED_CLOSE_PROJECT);
        assert(readFile(repository / ".git" / "config") == "keep");
        assert(archiveHas(root / "Repository.fry", ".git/config"));
    }

#ifndef _WIN32
    {
        const fs::path linkProject = root / "LinkProject.fry";
        fray::FrayManager app;
        assert(app.openProject(linkProject.string()) == fray::errors::NONE);
        auto& project = app.project("LinkProject");
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
        assert(app.openProject(cleanup.string()) == fray::errors::NONE);
        auto& project = app.project("Cleanup");
        assert(project.set("value", 42) == fray::errors::NONE);
        fs::permissions(workspace, fs::perms::owner_read | fs::perms::owner_exec);
        assert(project.close() == fray::errors::FAILED_CLOSE_PROJECT);
        assert(fs::exists(cleanup) && fs::exists(workspace));
        const std::string saved = readFile(cleanup);
        assert(project.openState("plugin") == fray::errors::FAILED_OPEN_STORE);
        fs::permissions(workspace, fs::perms::owner_all);
        assert(project.close() == fray::errors::NONE);
        assert(!fs::exists(workspace) && readFile(cleanup) == saved);
        assert(app.openProject(cleanup.string()) == fray::errors::NONE);
        int value = 0;
        assert(app.project("Cleanup").get("value", value) == fray::errors::NONE && value == 42);
        assert(app.project("Cleanup").close() == fray::errors::NONE);
    }
#endif

    {
        fray::FrayManager app;
        const fs::path automatic = root / "Automatic.fry";
        assert(app.openProject(automatic.string()) == fray::errors::NONE);
        assert(app.project("Automatic").set("value", 42) == fray::errors::NONE);
    }
    assert(fs::exists(root / "Automatic.fry"));
    assert(!fs::exists(root / "Automatic"));
}
