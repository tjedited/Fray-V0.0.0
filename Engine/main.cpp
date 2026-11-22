/* main.cpp */
#include "main.hpp"

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

    fray::files::FileManager project;
    ERR(project.open("project.fry"));

    fray::state::StateManager state;
    fray::state::StateManager test;
    ERR(state.open(project));

    ERR(state.set("application.id", "Fray Test Build 1"));
    ERR(state.set("engine.version.major", 1));
    ERR(state.set("engine.version.minor", 2));
    ERR(state.set("engine.version.bug", 3));

    ERR(test.open(project, "test"));
    if (test.remove("app.yoyo") != fray::errors::NONE) {
        ERR(test.set("app.yoyo", "ma"));
    }

    ERR(state.set("ui.version.major", 4));
    ERR(state.set("ui.version.minor", 5));
    ERR(state.set("ui.version.bug", 6));

    F_long uiVersionMajor, uiVersionMinor, uiVersionBug;
    ERR(state.get("ui.version.major", uiVersionMajor));
    ERR(state.get("ui.version.minor", uiVersionMinor));
    ERR(state.get("ui.version.bug", uiVersionBug));
    fray::log::engineInfo("The UI Major version is %d.%d.%d", uiVersionMajor, uiVersionMinor, uiVersionBug);

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