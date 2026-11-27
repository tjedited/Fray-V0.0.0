/* main.cpp */
#include "main.hpp"

#include <filesystem>
#include <string>

// Starts the UI and tells it which port the engine is listening on.
static F_err launchElectron(
    const char* executable,
    F_ushort port)
{
    const std::filesystem::path electronDirectory =
        (std::filesystem::absolute(executable).parent_path() / ".." / ".." / ".." / "Electron").lexically_normal();
    return fray::process::spawn({"npm", "run", "start"}, electronDirectory,
        {{"FRAY_ENGINE_PORT", std::to_string(port)}});
}

F_err main(
    F_long argc,
    F_char *argv[])
{
    bool launchUI = true;
    fray::log::engineInfo("Receieved the following arguments:");
    for (F_long i = 0; i < argc; i++)
    {
        fray::log::engineInfo(argv[i]);
        if (std::string(argv[i]) == "--no-ui")
            launchUI = false;
    }

    fray::log::engineInfo("Starting Engine.");

    // main owns the ThreadManager and declares it first, so it is destroyed last. Every engine thread
    // registers here, and it names any thread still running when the engine exits.
    fray::threads::ThreadManager threads;
    fray::FrayManager app(threads);
    fray::ipc::IPCManager ipc(threads, app);

    // Port 0 lets the OS pick a free port, which Electron is told about when it is launched.
    const auto server = ipc.createTCPServer(0);
    ipc.start();

    if (launchUI)
        ERR(launchElectron(argv[0], server->port()));

    // The network and message threads do the work; main waits until the UI sends the quit command.
    ipc.wait();

    fray::log::engineInfo("Exiting Engine.");
    return fray::errors::NONE;
}
