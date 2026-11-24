/* main.cpp */
#include "main.hpp"

#include <filesystem>
#include <iostream>
#include <future>
#include <limits>
#include <string>
#include <vector>

F_err TCPMessageHandler(
    std::string incomingMessage)
{
    F_err err = fray::errors::NONE;

    fray::log::engineInfo("Message handler says, %s", incomingMessage.c_str());

    return err;
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

F_err main(
    F_long argc,
    F_char *argv[])
{
    F_err err = fray::errors::NONE;
    const std::vector<std::string> names = {"TestProjectA", "TestProjectB", "TestProjectC"};

    fray::FrayManager app;

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

    /*
    F_err err = fray::errors::NONE;

    fray::log::engineInfo("Receieved the following arguments:");
    for (F_long i = 0; i < argc; i++)
        fray::log::engineInfo(argv[i]);

    fray::log::engineInfo("Starting Engine.");

    fray::ipc::IPCManager ipc;

    // The TCP ownership needs to change here.
    // IPCManager should be responsible for holding references to servers and trafficing messages between them.
    // It can also destroy servers if no clients connect within a certain timespan.
    ipc.createTCPServer(1234)->setMessageHandler(TCPMessageHandler);
    // ipc.createTCPServer(2345);
    // ipc.createTCPServer(3456);

    ipc.run();

    fray::log::engineInfo("Exiting Engine.");
    return 0;
    */
}