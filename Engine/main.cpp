/* main.cpp */
#include "main.hpp"

#include <iostream>

F_err TCPMessageHandler(
    std::string incomingMessage)
{
    F_err err = fray::errors::NONE;

    fray::log::engineInfo("Message handler says, %s", incomingMessage.c_str());

    return err;
}

F_err main(
    F_long argc,
    F_char *argv[])
{
    F_err err = fray::errors::NONE;

    fray::FrayManager app;
    F_err opened = app.openProject("TestProject.fry");
    if (opened == fray::errors::PROJECT_CONFLICT)
    {
        std::cout << "Both TestProject.fry and its working folder exist.\n"
                     "1: Open the archive in a separate folder\n"
                     "2: Open the working folder and save to a separate archive\n"
                     "0: Cancel\n> ";
        int choice = 0;
        if (!(std::cin >> choice) || (choice != 1 && choice != 2))
        {
            fray::log::engineError("Project opening cancelled.");
            return fray::errors::FAILED_OPEN_PROJECT;
        }
        opened = app.openProject("TestProject.fry", choice == 1
            ? fray::files::ConflictChoice::Archive : fray::files::ConflictChoice::Folder);
    }
    ERR(opened);

    fray::ProjectManager& project = app.project("TestProject");

    ERR(project.set("project.version.major", 0));
    ERR(project.set("project.version.minor", 0));
    ERR(project.set("project.version.bug", 0));
    std::string projectName;
    F_long projectMajor;
    ERR(project.get("project.name", projectName));
    ERR(project.get("project.version.major", projectMajor));
    fray::log::engineInfo("Project %s has major version %d", projectName.c_str(), projectMajor);

    ERR(project.set("application.id", "Fray Test Build 1"));
    ERR(project.set("engine.version.major", 1));
    ERR(project.set("engine.version.minor", 2));
    ERR(project.set("engine.version.bug", 3));

    ERR(project.openState("test"));
    fray::state::StateManager& test = project.state("test");
    ERR(test.set("app.yoyo", "ma"));

    ERR(project.set("ui.version.major", 4));
    ERR(project.set("ui.version.minor", 5));
    ERR(project.set("ui.version.bug", 6));

    F_long uiVersionMajor, uiVersionMinor, uiVersionBug;
    ERR(project.get("ui.version.major", uiVersionMajor));
    ERR(project.get("ui.version.minor", uiVersionMinor));
    ERR(project.get("ui.version.bug", uiVersionBug));
    fray::log::engineInfo("The UI Major version is %d.%d.%d", uiVersionMajor, uiVersionMinor, uiVersionBug);

    const std::string archive = project.fileManager().archivePath().string();
    ERR(project.close());
    fray::log::engineInfo("Saved project to %s", archive.c_str());
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