#include "fray/fray_manager.hpp"

#include <sqlite3.h>

#include <atomic>
#include <cassert>
#include <chrono>
#include <filesystem>
#include <fstream>
#include <functional>
#include <string>
#include <thread>
#include <vector>

namespace fs = std::filesystem;
using namespace std::chrono_literals;

static void exec(const fs::path& database, const std::string& sql)
{
    sqlite3* db = nullptr;
    assert(sqlite3_open(database.string().c_str(), &db) == SQLITE_OK);
    assert(sqlite3_exec(db, sql.c_str(), nullptr, nullptr, nullptr) == SQLITE_OK);
    assert(sqlite3_close(db) == SQLITE_OK);
}

static void makeFrayDatabase(const fs::path& database, const std::string& marker)
{
    fs::create_directories(database.parent_path());
    exec(database, "CREATE TABLE fray_state_46726179 (key TEXT PRIMARY KEY NOT NULL, type INTEGER NOT NULL, "
                   "value NOT NULL); INSERT INTO fray_state_46726179 VALUES ('marker', 1, '" + marker + "')");
}


static bool waitFor(const std::function<bool()>& condition)
{
    for (int i = 0; i < 100; ++i)
    {
        if (condition())
            return true;
        std::this_thread::sleep_for(100ms);
    }
    return false;
}

static bool projectIsOpen(fray::FrayManager& app, const std::string& name)
{
    try
    {
        return app.project(name).isOpen();
    }
    catch (const std::out_of_range&)
    {
        return false;
    }
}

static std::string storedName(fray::ProjectManager& project)
{
    std::string name;
    assert(project.get("project.info.name", name) == fray::errors::NONE);
    return name;
}

int main(int argc, char** argv)
{
    assert(argc == 2);
    const fs::path root(argv[1]);

    // Renaming the .fry while Fray is closed renames the project and its database on the next open.
    {
        const fs::path first = root / "Alpha.fry";
        {
            fray::FrayManager app;
            assert(app.openProject(first.string()).get() == fray::errors::NONE);
            assert(app.project("Alpha").set("marker", "alpha") == fray::errors::NONE);
            assert(app.closeProject("Alpha") == fray::errors::NONE);
        }
        fs::rename(first, root / "Beta.fry");
        fray::FrayManager app;
        assert(app.openProject((root / "Beta.fry").string()).get() == fray::errors::NONE);
        auto& project = app.project("Beta");
        std::string marker;
        assert(project.get("marker", marker) == fray::errors::NONE && marker == "alpha");
        assert(storedName(project) == "Beta");
        assert(fs::exists(root / "Beta" / "Beta.sqlite") && !fs::exists(root / "Beta" / "Alpha.sqlite"));
        assert(app.closeProject("Beta") == fray::errors::NONE);
        assert(fs::exists(root / "Beta.fry") && !fs::exists(root / "Beta") && !fs::exists(root / "Beta.lock"));
    }

    // A lone database that is not a Fray database is left alone and a new one is created.
    {
        const fs::path folder = root / "Gamma";
        fs::create_directories(folder);
        exec(folder / "junk.sqlite", "CREATE TABLE other (a)");
        fray::FrayManager app;
        assert(app.openProject(folder.string()).get() == fray::errors::NONE);
        assert(fs::exists(folder / "Gamma.sqlite") && fs::exists(folder / "junk.sqlite"));
        assert(storedName(app.project("Gamma")) == "Gamma");
        assert(app.closeProject("Gamma") == fray::errors::NONE);
    }

    // A lone Fray database with another name is adopted.
    {
        const fs::path folder = root / "Delta";
        makeFrayDatabase(folder / "old-name.sqlite", "delta");
        fray::FrayManager app;
        assert(app.openProject(folder.string()).get() == fray::errors::NONE);
        assert(fs::exists(folder / "Delta.sqlite") && !fs::exists(folder / "old-name.sqlite"));
        std::string marker;
        assert(app.project("Delta").get("marker", marker) == fray::errors::NONE && marker == "delta");
        assert(storedName(app.project("Delta")) == "Delta");
        assert(app.closeProject("Delta") == fray::errors::NONE);
    }

    // Several candidates: non-Fray files are ruled out, the rest are offered, the choice is applied.
    {
        const fs::path folder = root / "Multi";
        makeFrayDatabase(folder / "one.sqlite", "one");
        makeFrayDatabase(folder / "two.sqlite", "two");
        exec(folder / "junk.sqlite", "CREATE TABLE other (a)");
        fray::FrayManager app;
        assert(app.openProject(folder.string()).get() == fray::errors::DATABASE_CONFLICT);
        assert(app.databaseCandidates("Multi") == (std::vector<std::string>{"one", "two"}));
        assert(!projectIsOpen(app, "Multi"));
        assert(app.resolveDatabase("Multi", fray::DatabaseChoice::use("nope")) == fray::errors::FAILED_OPEN_PROJECT);
        assert(app.resolveDatabase("Multi", fray::DatabaseChoice::use("two")) == fray::errors::NONE);
        std::string marker;
        assert(app.project("Multi").get("marker", marker) == fray::errors::NONE && marker == "two");
        assert(fs::exists(folder / "Multi.sqlite") && !fs::exists(folder / "two.sqlite") &&
               fs::exists(folder / "one.sqlite") && fs::exists(folder / "junk.sqlite"));
        assert(app.closeProject("Multi") == fray::errors::NONE);
    }
    {
        const fs::path folder = root / "Fresh";
        makeFrayDatabase(folder / "one.sqlite", "one");
        makeFrayDatabase(folder / "two.sqlite", "two");
        fray::FrayManager app;
        assert(app.openProject(folder.string()).get() == fray::errors::DATABASE_CONFLICT);
        assert(app.resolveDatabase("Fresh", fray::DatabaseChoice::create()) == fray::errors::NONE);
        std::string marker;
        assert(app.project("Fresh").get("marker", marker) == fray::errors::STATE_NOT_FOUND);
        assert(fs::exists(folder / "one.sqlite") && fs::exists(folder / "two.sqlite"));
        assert(app.closeProject("Fresh") == fray::errors::NONE);
    }
    {
        const fs::path folder = root / "NoDecision";
        makeFrayDatabase(folder / "one.sqlite", "one");
        makeFrayDatabase(folder / "two.sqlite", "two");
        fray::FrayManager app;
        std::atomic<int> completions{0};
        for (int i = 0; i < 2; ++i)
        {
            auto future = app.openProject(folder.string(), fray::files::ConflictChoice::Ask,
                [&](F_err result) { assert(result == fray::errors::DATABASE_CONFLICT); ++completions; }, true);
            assert(future.get() == fray::errors::DATABASE_CONFLICT);
            assert(!fs::exists(root / "NoDecision.lock"));
        }
        assert(completions == 2);
    }

    // Cancelling removes a folder that was only extracted for the choice and keeps the .fry file.
    {
        const fs::path source = root / "Packed";
        makeFrayDatabase(source / "one.sqlite", "one");
        makeFrayDatabase(source / "two.sqlite", "two");
        {
            fray::FrayManager app;
            assert(app.openProject(source.string()).get() == fray::errors::DATABASE_CONFLICT);
            assert(app.resolveDatabase("Packed", fray::DatabaseChoice::use("one")) == fray::errors::NONE);
            assert(app.closeProject("Packed") == fray::errors::NONE);
        }
        assert(fs::exists(root / "Packed.fry") && !fs::exists(source));
        // Add more candidates to the packaged project.
        {
            fray::FrayManager app;
            assert(app.openProject((root / "Packed.fry").string()).get() == fray::errors::NONE);
            auto& project = app.project("Packed");
            makeFrayDatabase(project.fileManager().workingDirectory() / "extra.sqlite", "extra");
            makeFrayDatabase(project.fileManager().workingDirectory() / "extra2.sqlite", "extra2");
            assert(app.closeProject("Packed") == fray::errors::NONE);
        }
        fray::FrayManager app;
        // Packed.sqlite is still named after the project, so no choice is needed yet.
        assert(app.openProject((root / "Packed.fry").string()).get() == fray::errors::NONE);
        assert(app.closeProject("Packed") == fray::errors::NONE);
        fs::rename(root / "Packed.fry", root / "Moved.fry");
        assert(app.openProject((root / "Moved.fry").string()).get() == fray::errors::DATABASE_CONFLICT);
        assert(app.cancelProject("Moved") == fray::errors::NONE);
        assert(fs::exists(root / "Moved.fry") && !fs::exists(root / "Moved") && !fs::exists(root / "Moved.lock"));
    }

    // Changing project.info.name while running renames the folder, database and lock together.
    {
        const fs::path folder = root / "Live";
        fray::FrayManager app;
        assert(app.openProject(folder.string()).get() == fray::errors::NONE);
        auto& project = app.project("Live");
        assert(project.set("marker", "live") == fray::errors::NONE);
        assert(project.openState("extra") == fray::errors::NONE);
        assert(project.state("extra").set("answer", 42) == fray::errors::NONE);
        assert(fs::exists(root / "Live.lock"));
        assert(project.set("project.info.name", "Live2") == fray::errors::NONE);
        assert(!fs::exists(folder) && fs::exists(root / "Live2" / "Live2.sqlite") &&
               !fs::exists(root / "Live2" / "Live.sqlite"));
        assert(!fs::exists(root / "Live.lock") && fs::exists(root / "Live2.lock"));
        assert(project.name() == "Live2" && storedName(project) == "Live2");
        std::string marker;
        int answer = 0;
        assert(project.get("marker", marker) == fray::errors::NONE && marker == "live");
        assert(project.state("extra").get("answer", answer) == fray::errors::NONE && answer == 42);
        assert(&app.project("Live2") == &project);
        assert(project.set("project.info.name", "bad/name") == fray::errors::FAILED_RENAME_PROJECT);
        assert(project.set("project.info.name", 5) == fray::errors::FAILED_SAVE_STATE);
        fs::create_directories(root / "Taken");
        assert(project.set("project.info.name", "Taken") == fray::errors::FAILED_RENAME_PROJECT);
        assert(project.name() == "Live2" && fs::exists(root / "Live2" / "Live2.sqlite"));
        assert(project.set("marker", "still") == fray::errors::NONE);
        assert(app.closeProject("Live2") == fray::errors::NONE);
        assert(fs::exists(root / "Live2.fry") && !fs::exists(root / "Live2") && !fs::exists(root / "Live.fry"));
        assert(!fs::exists(root / "Live2.lock"));
    }

    // A running project follows the user renaming its working folder...
    {
        const fs::path folder = root / "Watched";
        fray::FrayManager app;
        assert(app.openProject(folder.string()).get() == fray::errors::NONE);
        assert(app.project("Watched").set("marker", "watched") == fray::errors::NONE);
        fs::rename(folder, root / "Renamed");
        assert(waitFor([&] { return projectIsOpen(app, "Renamed"); }));
        auto& project = app.project("Renamed");
        assert(fs::exists(root / "Renamed" / "Renamed.sqlite") && !fs::exists(root / "Renamed" / "Watched.sqlite"));
        assert(storedName(project) == "Renamed" && fs::exists(root / "Renamed.lock") && !fs::exists(root / "Watched.lock"));
        std::string marker;
        assert(project.get("marker", marker) == fray::errors::NONE && marker == "watched");
        assert(app.closeProject("Renamed") == fray::errors::NONE);
        assert(fs::exists(root / "Renamed.fry"));
    }

    // ...and its database being renamed.
    {
        const fs::path folder = root / "DbWatched";
        fray::FrayManager app;
        assert(app.openProject(folder.string()).get() == fray::errors::NONE);
        assert(app.project("DbWatched").set("marker", "db") == fray::errors::NONE);
        fs::rename(folder / "DbWatched.sqlite", folder / "Other.sqlite");
        assert(waitFor([&] { return projectIsOpen(app, "Other"); }));
        auto& project = app.project("Other");
        assert(!fs::exists(folder) && fs::exists(root / "Other" / "Other.sqlite"));
        assert(storedName(project) == "Other" && fs::exists(root / "Other.lock"));
        std::string marker;
        assert(project.get("marker", marker) == fray::errors::NONE && marker == "db");
        assert(app.closeProject("Other") == fray::errors::NONE);
    }

    // A renamed or deleted lock file is recreated; the project keeps its name and closes cleanly.
    {
        const fs::path folder = root / "Locked";
        fray::FrayManager app;
        assert(app.openProject(folder.string()).get() == fray::errors::NONE);
        assert(fs::exists(root / "Locked.lock"));
        fs::rename(root / "Locked.lock", root / "Stray.lock");
        assert(waitFor([&] { return fs::exists(root / "Locked.lock"); }));
        assert(projectIsOpen(app, "Locked"));
        fs::remove(root / "Locked.lock");
        assert(waitFor([&] { return fs::exists(root / "Locked.lock"); }));
        assert(app.closeProject("Locked") == fray::errors::NONE);
        assert(!fs::exists(root / "Locked.lock"));
        assert(fs::exists(root / "Locked.fry"));
        fs::remove(root / "Stray.lock");
    }

    // Opening a .fry snapshots its database and removes the .fry until the project is packaged again.
    {
        const fs::path archive = root / "Snap.fry";
        for (int round = 0; round < 3; ++round)
        {
            fray::FrayManager app;
            assert(app.openProject(archive.string()).get() == fray::errors::NONE);
            auto& project = app.project("Snap");
            assert(project.set("marker", round) == fray::errors::NONE);
            if (round > 0)
            {
                assert(!fs::exists(archive));
                std::size_t count = 0;
                for (const auto& entry : fs::directory_iterator(project.fileManager().workingDirectory() / "snapshots"))
                    count += entry.path().filename().string().rfind("Snap-", 0) == 0 && entry.path().extension() == ".sqlite";
                assert(count == static_cast<std::size_t>(round));
            }
            assert(app.closeProject("Snap") == fray::errors::NONE);
            assert(fs::exists(archive));
        }
    }

    // Working folders are snapshotted too; a renamed database is copied under its old name, before the rename.
    {
        const auto snapshotNames = [](const fs::path& folder)
        {
            std::vector<std::string> names;
            if (fs::exists(folder / "snapshots"))
                for (const auto& entry : fs::directory_iterator(folder / "snapshots"))
                    names.push_back(entry.path().filename().string());
            return names;
        };
        {
            const fs::path folder = root / "FolderSnap";
            fray::FrayManager app;
            assert(app.openProject(folder.string()).get() == fray::errors::NONE);
            assert(app.closeProject("FolderSnap") == fray::errors::NONE);
            assert(fs::exists(root / "FolderSnap.fry"));
            assert(app.openProject((root / "FolderSnap.fry").string()).get() == fray::errors::NONE);
            assert(app.project("FolderSnap").set("project.preferences.packageOnClose", false) == fray::errors::NONE);
            assert(app.closeProject("FolderSnap") == fray::errors::NONE);
            assert(fs::is_directory(folder) && !fs::exists(root / "FolderSnap.fry"));
            const std::size_t before = snapshotNames(folder).size();
            assert(app.openProject(folder.string()).get() == fray::errors::NONE);
            assert(snapshotNames(folder).size() == before + 1);
            assert(app.closeProject("FolderSnap") == fray::errors::NONE);
        }
        {
            const fs::path folder = root / "Adopted";
            fs::create_directories(folder);
            makeFrayDatabase(folder / "Original.sqlite", "adopt");
            fray::FrayManager app;
            assert(app.openProject(folder.string()).get() == fray::errors::NONE);
            const auto names = snapshotNames(folder);
            assert(names.size() == 1 && names[0].rfind("Original-", 0) == 0);
            assert(fs::exists(folder / "Adopted.sqlite") && !fs::exists(folder / "Original.sqlite"));
            assert(app.closeProject("Adopted") == fray::errors::NONE);
        }
        {
            const fs::path folder = root / "EmptyFolder";
            fs::create_directories(folder);
            fray::FrayManager app;
            assert(app.openProject(folder.string()).get() == fray::errors::NONE);
            assert(snapshotNames(folder).empty());
            assert(app.closeProject("EmptyFolder") == fray::errors::NONE);
        }
    }

    // If both are renamed at once, the folder name wins.
    {
        const fs::path folder = root / "Both";
        fray::FrayManager app;
        assert(app.openProject(folder.string()).get() == fray::errors::NONE);
        auto& project = app.project("Both");
        auto hold = project.watcher().hold();
        fs::rename(folder / "Both.sqlite", folder / "FromDb.sqlite");
        fs::rename(folder, root / "FromFolder");
        hold.unlock();
        assert(waitFor([&] { return projectIsOpen(app, "FromFolder"); }));
        assert(fs::exists(root / "FromFolder" / "FromFolder.sqlite") && !fs::exists(root / "FromFolder" / "FromDb.sqlite"));
        assert(app.closeProject("FromFolder") == fray::errors::NONE);
    }

    // Several projects open at once, each on its own thread.
    {
        fray::FrayManager app;
        std::vector<std::future<F_err>> opening;
        for (const char* name : {"P1", "P2", "P3"})
            opening.push_back(app.openProject((root / name).string()));
        for (auto& result : opening)
            assert(result.get() == fray::errors::NONE);
        for (const char* name : {"P1", "P2", "P3"})
            assert(app.project(name).isOpen());
        assert(app.openProject((root / "P2").string()).get() == fray::errors::PROJECT_ALREADY_OPEN);
        assert(app.close() == fray::errors::NONE);
        assert(fs::exists(root / "P1.fry") && fs::exists(root / "P3.fry"));
    }

    // FileWatcher on its own.
    {
        const fs::path folder = root / "Plain";
        fs::create_directories(folder / "sub");
        std::ofstream(folder / "a.txt") << "a";
        fray::watch::FileWatcher watcher;
        assert(watcher.watch(folder));
        std::vector<fray::watch::Change> seen;
        watcher.subscribe(nullptr, [&](const fray::watch::Change& change) { seen.push_back(change); });
        assert(watcher.poll() == 0);

        std::ofstream(folder / "b.txt") << "b";
        fs::rename(folder / "a.txt", folder / "sub" / "c.txt");
        assert(watcher.poll() == 2 && watcher.dispatch() == 2);
        using Kind = fray::watch::ChangeKind;
        bool renamed = false, added = false;
        for (const auto& change : seen)
        {
            renamed = renamed || (change.kind == Kind::Renamed && change.previousRelative == "a.txt" &&
                                  change.relative == "sub/c.txt");
            added = added || (change.kind == Kind::Added && change.relative == "b.txt");
        }
        assert(renamed && added);

        seen.clear();
        std::this_thread::sleep_for(20ms);
        std::ofstream(folder / "b.txt") << "longer";
        assert(watcher.poll() == 1 && watcher.dispatch() == 1);
        assert(seen.front().kind == Kind::Modified && seen.front().relative == "b.txt");

        seen.clear();
        fs::remove(folder / "b.txt");
        assert(watcher.poll() == 1 && watcher.dispatch() == 1);
        assert(seen.front().kind == Kind::Removed && seen.front().relative == "b.txt");

        seen.clear();
        fs::rename(folder / "sub", folder / "moved");
        assert(watcher.poll() == 1 && watcher.dispatch() == 1);
        assert(seen.front().kind == Kind::Renamed && seen.front().relative == "moved" && seen.front().directory);

        seen.clear();
        fs::rename(folder, root / "Plain2");
        assert(watcher.poll() >= 1 && watcher.dispatch() >= 1);
        assert(seen.front().root && seen.front().kind == Kind::Renamed && seen.front().path == root / "Plain2");
        seen.clear();
        fs::remove_all(root / "Plain2");
        watcher.poll();
        watcher.dispatch();
        assert(seen.front().root && seen.front().kind == Kind::Removed);
    }

    // ThreadManager and TaskQueue.
    {
        fray::threads::ThreadManager threads;
        std::atomic<int> ticks{0};
        const auto id = threads.spawn("ticker", [&](fray::threads::StopToken token)
        {
            while (!token.waitFor(5ms))
                ++ticks;
        });
        assert(waitFor([&] { return ticks > 2; }) && threads.running(id));
        threads.requestStop(id);
        assert(waitFor([&] { return !threads.running(id); }));
        assert(threads.join(id) && threads.running() == 0);

        auto queue = std::make_shared<fray::threads::TaskQueue>();
        std::atomic<bool> extraAlive{true};
        const auto worker = threads.spawn("worker", [&, queue](fray::threads::StopToken)
        {
            queue->run([&] { return extraAlive.load(); });
        });
        assert(queue->call([] { return 7; }).get() == 7);
        queue->shutdown();
        std::this_thread::sleep_for(200ms);
        assert(threads.running(worker));
        extraAlive = false;
        assert(waitFor([&] { return !threads.running(worker); }));
        assert(!queue->post([] {}));
    }
}
