/* process_manager.hpp */

#ifndef _FRAY_PROCESS_MANAGER_HPP_
#define _FRAY_PROCESS_MANAGER_HPP_

#include <cstdlib>
#include <filesystem>
#include <string>
#include <utility>
#include <vector>

#ifdef _WIN32
#include <windows.h>
#else
#include <sys/types.h>
#include <unistd.h>
#endif

#include "errors.hpp"
#include "log_manager.hpp"
#include "types.hpp"

namespace fray
{
    namespace process
    {
        // Starts a child process without waiting for it. The child inherits this process's
        // stdio and the given environment variables, and runs in workingDirectory.
        inline F_err spawn(
            const std::vector<std::string> &command,
            const std::filesystem::path &workingDirectory,
            const std::vector<std::pair<std::string, std::string>> &environment = {})
        {
            if (command.empty())
            {
                log::engineError("Cannot spawn a process: empty command.");
                return errors::FAILED_SPAWN_PROCESS;
            }

            // The environment is changed before the spawn while the engine is still single-threaded.
            for (const auto &variable : environment)
#ifdef _WIN32
                _putenv_s(variable.first.c_str(), variable.second.c_str());

            std::string commandLine = "cmd /c";
            for (const auto &argument : command)
                commandLine += " " + argument;
            STARTUPINFOA startup{};
            startup.cb = sizeof(startup);
            PROCESS_INFORMATION info{};
            const std::string directory = workingDirectory.string();
            if (!CreateProcessA(nullptr, commandLine.data(), nullptr, nullptr, TRUE, 0, nullptr,
                                directory.c_str(), &startup, &info))
            {
                log::engineError("Failed to spawn %s.", command.front().c_str());
                return errors::FAILED_SPAWN_PROCESS;
            }
            CloseHandle(info.hThread);
            CloseHandle(info.hProcess);
#else
                setenv(variable.first.c_str(), variable.second.c_str(), 1);

            const pid_t child = fork();
            if (child < 0)
            {
                log::engineError("Failed to spawn %s.", command.front().c_str());
                return errors::FAILED_SPAWN_PROCESS;
            }
            if (child == 0)
            {
                if (chdir(workingDirectory.c_str()) != 0)
                    _exit(126);
                std::vector<char *> arguments;
                for (const auto &argument : command)
                    arguments.push_back(const_cast<char *>(argument.c_str()));
                arguments.push_back(nullptr);
                execvp(arguments[0], arguments.data());
                _exit(127);
            }
#endif
            log::engineInfo("Spawned %s.", command.front().c_str());
            return errors::NONE;
        }
    } // namespace process
} // namespace fray

#endif
