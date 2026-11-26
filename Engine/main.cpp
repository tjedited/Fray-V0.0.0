/* main.cpp */
#include "main.hpp"

#include <filesystem>
#include <iostream>
#include <future>
#include <limits>
#include <string>
#include <vector>

static fray::ipc::Frame makeTestFrame(fray::ProcessKind destination)
{
    const auto frame = fray::message::makeEngineFrame(destination, 0, fray::COMMAND_TEST,
        fray::PAYLOAD_TYPE_JSON, R"({"message":"Hello from the Engine"})");
    if (!frame)
        fray::log::engineError("Failed to build test message.");
    return frame;
}

// Starts the UI and tells it which port the engine is listening on.
static F_err launchElectron(const char* executable, F_ushort port)
{
    const std::filesystem::path electronDirectory =
        (std::filesystem::absolute(executable).parent_path() / ".." / ".." / ".." / "Electron").lexically_normal();
    return fray::process::spawn({"npm", "run", "start"}, electronDirectory,
        {{"FRAY_ENGINE_PORT", std::to_string(port)}});
}

// Waits for an open to finish, then asks the user about any naming or database conflict.
// Eventually we will abstract these to a generic prompt function that gets kicked up to Electron.
static F_err finishOpening(fray::FrayManager& app, const std::string& name, std::future<F_err>& opening)
{
    F_err opened = opening.get();
    if (opened == fray::errors::PROJECT_CONFLICT)
    {
        std::cout << "Fray has spotted a naming conflict. You have both a " << name << " working folder "
                  << "and a " << name << ".fry file in the same directory. What would you like to do?\n"
                  << "1. Open " << name << ".fry and rename the working folder to " << name << "-unselected-[#].\n"
                  << "2. Use the " << name << " working folder and rename the .fry file to " << name << "-unselected-[#].fry.\n"
                  << "0: Cancel\n> ";
        int choice = 0;
        if (!(std::cin >> choice) || (choice != 1 && choice != 2))
        {
            fray::log::engineError("Opening %s cancelled.", name.c_str());
            return fray::errors::FAILED_OPEN_PROJECT;
        }
        opened = app.openProject(name + ".fry", choice == 1
            ? fray::files::ConflictChoice::Archive : fray::files::ConflictChoice::Folder).get();
    }
    if (opened == fray::errors::DATABASE_CONFLICT)
    {
        const std::vector<std::string> candidates = app.databaseCandidates(name);
        std::cout << "Fray found multiple database files, but none match the name " << name << ". "
                  << "What would you like to do?\n";
        for (std::size_t i = 0; i < candidates.size(); ++i)
            std::cout << i + 1 << ". Use " << candidates[i] << " and rename it to " << name << ".\n";
        std::cout << candidates.size() + 1 << ". Create a new " << name << ".sqlite file.\n0. Cancel\n> ";
        std::size_t choice = 0;
        if (!(std::cin >> choice) || choice == 0 || choice > candidates.size() + 1)
        {
            app.cancelProject(name);
            fray::log::engineError("Opening %s cancelled.", name.c_str());
            return fray::errors::FAILED_OPEN_PROJECT;
        }
        opened = app.resolveDatabase(name, choice <= candidates.size()
            ? fray::DatabaseChoice::use(candidates[choice - 1]) : fray::DatabaseChoice::create());
    }
    return opened;
}

// Terminal-driven multi-project demo. Not run while the UI connects over TCP.
[[maybe_unused]] static F_err terminalDemo(fray::FrayManager& app)
{
    F_err err = fray::errors::NONE;
    const std::vector<std::string> names = {"TestProjectA", "TestProjectB", "TestProjectC"};

    // Start every open before waiting on any of them, so each project loads on its own thread.
    std::vector<std::future<F_err>> openings;
    for (const auto& name : names)
        openings.push_back(app.openProject(name + ".fry"));

    // Hold references rather than names: a project can be renamed while it runs.
    std::vector<fray::ProjectManager*> projects;
    for (std::size_t i = 0; i < names.size(); ++i)
    {
        const F_err opened = finishOpening(app, names[i], openings[i]);
        if (opened != fray::errors::NONE)
        {
            fray::log::engineError("Could not open %s: %s", names[i].c_str(), fray::errors::description(opened));
            continue;
        }
        projects.push_back(&app.project(names[i]));
    }

    // Project and file-watcher threads keep running while main waits here, so working folders can be renamed by hand.
    std::cout << projects.size() << " project(s) running. Press Enter to close.\n> ";
    std::cin.ignore(std::numeric_limits<std::streamsize>::max(), '\n');
    std::cin.get();

    for (auto* project : projects)
    {
        const std::string name = project->name();
        const std::string archive = project->fileManager().archivePath().string();
        ERR2(app.closeProject(name));
        if (std::filesystem::exists(archive))
            fray::log::engineInfo("Project %s closed and saved to %s", name.c_str(), archive.c_str());
        else
            fray::log::engineInfo("Project %s closed; working folder left unpackaged.", name.c_str());
    }
    return err;
}

F_err main(
    F_long argc,
    F_char *argv[])
{
    bool launchUI = true;
    bool testRendererIPC = false;
    fray::log::engineInfo("Receieved the following arguments:");
    for (F_long i = 0; i < argc; i++)
    {
        fray::log::engineInfo(argv[i]);
        if (std::string(argv[i]) == "--no-ui")
            launchUI = false;
        if (std::string(argv[i]) == "--test-renderer-ipc")
            testRendererIPC = true;
    }
    if (testRendererIPC && launchUI)
    {
        fray::log::engineError("--test-renderer-ipc requires --no-ui.");
        return fray::errors::FAILED_START;
    }

    fray::log::engineInfo("Starting Engine.");

    // main owns the ThreadManager and declares it first, so it is destroyed last. Every engine thread
    // registers here, and it names any thread still running when the engine exits.
    fray::threads::ThreadManager threads;
    fray::FrayManager app(threads);
    fray::ipc::IPCManager ipc(threads);

    // Port 0 lets the OS pick a free port, which Electron is told about when it is launched.
    const auto server = ipc.createTCPServer(0);
    // The test messages are sent now. Each waits in the router's queue until its peer announces that it is ready.
    ipc.send(makeTestFrame(fray::PROCESS_KIND_ELECTRON_MAIN));
    if (launchUI || testRendererIPC)
        ipc.send(makeTestFrame(fray::PROCESS_KIND_ELECTRON_RENDERER));
    ipc.start();

    if (launchUI)
        ERR(launchElectron(argv[0], server->port()));

    // The network and message threads do the work; main waits until the UI sends the quit command.
    ipc.wait();

    fray::log::engineInfo("Exiting Engine.");
    return fray::errors::NONE;
}
