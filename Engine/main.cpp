/* main.cpp */
#include "main.hpp"

F_err messageHandler()
{
    F_err err = fray::errors::NONE;

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

    fray::ipc::TCPServer mainServer;

    mainServer.setPort(1234);

    fray::log::engineInfo("Exiting.");
    return 0;
}