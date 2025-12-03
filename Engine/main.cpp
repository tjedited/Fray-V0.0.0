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

    fray::log::electronInfo("Sent the following arguments to the engine:");
    for (F_long i = 0; i < argc; i++)
        fray::log::electronInfo(argv[i]);

    fray::log::engineInfo("Starting Engine.");

    fray::ipc::IPCManager ipc;

    // The TCP ownership needs to change here.
    // IPCManager should be responsible for holding references to servers and trafficing messages between them.
    // It can also destroy servers if no clients connect within a certain timespan.
    ipc.createTCPServer(1234)->setMessageHandler(TCPMessageHandler);
    ipc.createTCPServer(2345);
    ipc.createTCPServer(3456);

    ipc.run();

    fray::log::engineInfo("Exiting Engine.");
    return 0;
}