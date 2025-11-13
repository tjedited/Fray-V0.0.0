/* main.cpp */
#include "main.hpp"

F_err TCPMessageHandler()
{
    F_err err = fray::errors::NONE;

    fray::log::engineInfo("Message handler!");

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

    fray::log::engineInfo("Starting.");

    fray::ipc::IPCManager ipc;

    auto server1 = ipc.createTCPServer(1234);
    auto server2 = ipc.createTCPServer(2345);
    auto server3 = ipc.createTCPServer(3456);

    ipc.run();

    fray::log::engineInfo("Exiting.");
    return 0;
}