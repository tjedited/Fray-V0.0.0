#include "fray/project_manager.hpp"

#include <cassert>
#include <filesystem>
#include <fstream>

namespace fs = std::filesystem;

int main(int argc, char** argv)
{
    assert(argc == 2);
    const fs::path root = argv[1];
    const fs::path project = root / "Project";
    const fs::path archive = root / "Project.fry";
    using fray::files::ConflictChoice;
    using fray::files::OpenMode;

    {
        fray::ProjectManager manager;
        assert(manager.open(project.string(), "Fray", ConflictChoice::Ask, nullptr, nullptr, OpenMode::CreateNew) ==
               fray::errors::NONE);
        assert(fs::is_regular_file(project / "Project.sqlite"));
        assert(manager.set("project.preferences.packageOnClose", false) == fray::errors::NONE);
        assert(manager.close() == fray::errors::NONE);
    }
    {
        fray::ProjectManager manager;
        assert(manager.open(project.string(), "Fray", ConflictChoice::Ask, nullptr, nullptr, OpenMode::CreateNew) ==
               fray::errors::PROJECT_FOLDER_EXISTS);
        assert(fs::is_regular_file(project / "Project.sqlite"));
        assert(manager.open(project.string(), "Fray", ConflictChoice::Ask, nullptr, nullptr, OpenMode::OpenExisting) ==
               fray::errors::NONE);
        assert(manager.close() == fray::errors::NONE);
        assert(fs::is_directory(project));
    }
    {
        std::ofstream(archive) << "archive marker";
        fray::ProjectManager manager;
        assert(manager.open(project.string(), "Fray", ConflictChoice::Ask, nullptr, nullptr, OpenMode::CreateNew) ==
               fray::errors::PROJECT_BOTH_EXIST);
        assert(fs::is_directory(project) && fs::is_regular_file(archive));
        assert(fs::remove(archive));
    }
    {
        const fs::path invalid = root / "Invalid";
        assert(fs::create_directory(invalid));
        std::ofstream(invalid / "marker.txt") << "keep";
        fray::ProjectManager manager;
        assert(manager.open(invalid.string(), "Fray", ConflictChoice::Ask, nullptr, nullptr, OpenMode::OpenExisting) ==
               fray::errors::INVALID_PROJECT_DATABASE);
        assert(fs::is_regular_file(invalid / "marker.txt"));
        assert(!fs::exists(invalid / "Invalid.sqlite"));
        assert(manager.open((root / "Missing").string(), "Fray", ConflictChoice::Ask, nullptr, nullptr,
                            OpenMode::OpenExisting) == fray::errors::PROJECT_NOT_FOUND);
        assert(!fs::exists(root / "Missing"));
    }
    {
        const fs::path path = root / "InvalidArchive";
        const fs::path archivePath = root / "InvalidArchive.fry";
        assert(fs::create_directory(path));
        std::ofstream(path / "InvalidArchive.sqlite") << "folder marker";
        std::ofstream(archivePath) << "invalid archive";
        fray::ProjectManager manager;
        assert(manager.open(path.string(), "Fray", ConflictChoice::Archive, nullptr, nullptr, OpenMode::OpenExisting) ==
               fray::errors::FAILED_OPEN_PROJECT);
        assert(fs::is_regular_file(path / "InvalidArchive.sqlite"));
        assert(fs::is_regular_file(archivePath));
        assert(!fs::exists(root / "InvalidArchive-unselected-1"));
    }
    {
        const fs::path path = root / "InvalidFolder";
        const fs::path archivePath = root / "InvalidFolder.fry";
        {
            fray::ProjectManager manager;
            assert(manager.open(path.string(), "Fray", ConflictChoice::Ask, nullptr, nullptr, OpenMode::CreateNew) ==
                   fray::errors::NONE);
            assert(manager.close(true) == fray::errors::NONE);
        }
        assert(fs::create_directory(path));
        std::ofstream(path / "marker") << "invalid folder";
        fray::ProjectManager manager;
        assert(manager.open(path.string(), "Fray", ConflictChoice::Folder, nullptr, nullptr, OpenMode::OpenExisting) ==
               fray::errors::INVALID_PROJECT_DATABASE);
        assert(fs::is_regular_file(path / "marker"));
        assert(fs::is_regular_file(archivePath));
        assert(!fs::exists(root / "InvalidFolder-unselected-1.fry"));
        assert(manager.open(path.string(), "Fray", ConflictChoice::Folder, nullptr, nullptr,
                            OpenMode::CreateInFolderResolve) == fray::errors::NONE);
        assert(fs::is_regular_file(path / "InvalidFolder.sqlite"));
        assert(fs::is_regular_file(root / "InvalidFolder-unselected-1.fry"));
        assert(fs::is_regular_file(path / "marker"));
        assert(manager.set("project.preferences.packageOnClose", false) == fray::errors::NONE);
        assert(manager.close() == fray::errors::NONE);
    }
    {
        const fs::path path = root / "ArchiveChoice";
        const fs::path archivePath = root / "ArchiveChoice.fry";
        {
            fray::ProjectManager manager;
            assert(manager.open(path.string(), "Fray", ConflictChoice::Ask, nullptr, nullptr, OpenMode::CreateNew) ==
                   fray::errors::NONE);
            assert(manager.set("project.preferences.packageOnClose", true) == fray::errors::NONE);
            assert(manager.close() == fray::errors::NONE);
        }
        {
            fray::ProjectManager manager;
            assert(manager.open(path.string(), "Fray", ConflictChoice::Ask, nullptr, nullptr, OpenMode::CreateNew) ==
                   fray::errors::PROJECT_ARCHIVE_EXISTS);
            assert(manager.open(path.string(), "Fray", ConflictChoice::Ask, nullptr, nullptr, OpenMode::OpenExisting) ==
                   fray::errors::NONE);
            assert(manager.close() == fray::errors::NONE);
        }
        assert(fs::create_directory(path));
        std::ofstream(path / "marker") << "keep";
        fray::ProjectManager manager;
        assert(manager.open(path.string(), "Fray", ConflictChoice::Archive, nullptr, nullptr, OpenMode::OpenExisting) ==
               fray::errors::NONE);
        assert(fs::is_regular_file(root / "ArchiveChoice-unselected-1" / "marker"));
        assert(manager.close() == fray::errors::NONE);
        assert(fs::is_regular_file(archivePath));
    }
    {
        const fs::path folder = root / "CreateHere";
        assert(fs::create_directory(folder));
        std::ofstream(folder / "marker") << "keep";
        fray::ProjectManager manager;
        assert(manager.open(folder.string(), "Fray", ConflictChoice::Folder, nullptr, nullptr, OpenMode::OpenSelected) ==
               fray::errors::INVALID_PROJECT_DATABASE);
        assert(manager.open(folder.string(), "Fray", ConflictChoice::Ask, nullptr, nullptr, OpenMode::CreateInFolder) ==
               fray::errors::NONE);
        assert(fs::is_regular_file(folder / "CreateHere.sqlite"));
        assert(fs::is_regular_file(folder / "marker"));
        assert(manager.set("project.preferences.packageOnClose", false) == fray::errors::NONE);
        assert(manager.close() == fray::errors::NONE);
        assert(manager.open(folder.string(), "Fray", ConflictChoice::Ask, nullptr, nullptr, OpenMode::CreateInFolder) ==
               fray::errors::PROJECT_FOLDER_EXISTS);
        assert(fs::is_regular_file(folder / "CreateHere.sqlite"));
    }
    {
        const fs::path folder = root / "BadDatabase";
        assert(fs::create_directory(folder));
        std::ofstream(folder / "BadDatabase.sqlite") << "preserve invalid database";
        fray::ProjectManager manager;
        assert(manager.open(folder.string(), "Fray", ConflictChoice::Ask, nullptr, nullptr, OpenMode::CreateInFolder) ==
               fray::errors::PROJECT_DATABASE_OCCUPIED);
        std::ifstream input(folder / "BadDatabase.sqlite");
        std::string contents;
        std::getline(input, contents);
        assert(contents == "preserve invalid database");
    }
    {
        const fs::path folder = root / "Sidecar";
        assert(fs::create_directory(folder));
        std::ofstream(folder / "Sidecar.sqlite-wal") << "preserve";
        fray::ProjectManager manager;
        assert(manager.open(folder.string(), "Fray", ConflictChoice::Ask, nullptr, nullptr, OpenMode::CreateInFolder) ==
               fray::errors::PROJECT_DATABASE_OCCUPIED);
        assert(fs::is_regular_file(folder / "Sidecar.sqlite-wal"));
        assert(!fs::exists(folder / "Sidecar.sqlite"));
    }
    {
        const fs::path folder = root / "Selection";
        assert(fs::create_directory(folder));
        std::ofstream(root / "Selection.fry") << "archive";
        fray::ProjectManager manager;
        assert(manager.open(folder.string(), "Fray", ConflictChoice::Folder, nullptr, nullptr, OpenMode::OpenSelected) ==
               fray::errors::PROJECT_CONFLICT);
        assert(fs::is_directory(folder) && fs::is_regular_file(root / "Selection.fry"));
        assert(fs::remove(folder));
        assert(manager.open(folder.string(), "Fray", ConflictChoice::Folder, nullptr, nullptr, OpenMode::OpenSelected) ==
               fray::errors::PROJECT_NOT_FOUND);
        assert(fs::is_regular_file(root / "Selection.fry"));
    }
}
