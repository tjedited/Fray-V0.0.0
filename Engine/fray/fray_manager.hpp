#ifndef FRAY_MANAGER_HPP
#define FRAY_MANAGER_HPP

#include <atomic>
#include <filesystem>
#include <memory>
#include <stdexcept>
#include <string>
#include <unordered_map>

#include "project_manager.hpp"

namespace fray
{
    class FrayManager
    {
        private:
            inline static std::atomic<bool> _active{false};
            std::string _applicationId;
            std::unordered_map<std::string, std::unique_ptr<ProjectManager>> _projects;

        public:
            explicit FrayManager(const std::string& applicationId = "Fray") : _applicationId(applicationId)
            {
                bool expected = false;
                if (!_active.compare_exchange_strong(expected, true))
                    throw std::logic_error("Only one FrayManager may exist in an engine process.");
            }
            FrayManager(const FrayManager&) = delete;
            FrayManager& operator=(const FrayManager&) = delete;

            ~FrayManager()
            {
                if (close() != errors::NONE)
                    log::engineError("Some projects could not be closed; check their archives and working folders.");
                _projects.clear();
                _active = false;
            }

            const std::string& applicationId() const { return _applicationId; }

            F_err openProject(const std::string& path, files::ConflictChoice choice = files::ConflictChoice::Ask)
            {
                if (path.empty())
                {
                    log::engineError("Cannot open project: path is empty.");
                    return errors::FAILED_OPEN_PROJECT;
                }
                std::error_code error;
                auto resolved = std::filesystem::weakly_canonical(path, error);
                if (error)
                {
                    log::engineError("Cannot resolve project path: %s", error.message().c_str());
                    return errors::FAILED_OPEN_PROJECT;
                }
                if (resolved.filename().empty() && resolved != resolved.root_path())
                    resolved = resolved.parent_path();
                const std::string name = resolved.extension() == ".fry"
                    ? resolved.stem().string() : resolved.filename().string();
                auto found = _projects.find(name);
                if (found != _projects.end())
                {
                    if (found->second->isOpen())
                    {
                        log::engineError("Project is already open: %s", name.c_str());
                        return errors::PROJECT_ALREADY_OPEN;
                    }
                    _projects.erase(found);
                }
                auto project = std::make_unique<ProjectManager>();
                const F_err result = project->open(path, _applicationId, choice);
                if (result != errors::NONE)
                    return result;
                _projects.emplace(project->name(), std::move(project));
                return errors::NONE;
            }

            ProjectManager& project(const std::string& name)
            {
                const auto found = _projects.find(name);
                if (found == _projects.end() || !found->second->isOpen())
                    throw std::out_of_range("Project is not open: " + name);
                return *found->second;
            }

            F_err closeProject(const std::string& name)
            {
                const auto found = _projects.find(name);
                if (found == _projects.end())
                {
                    log::engineError("Cannot close project: project is not open: %s", name.c_str());
                    return errors::FAILED_CLOSE_PROJECT;
                }
                if (found->second->isOpen())
                {
                    const F_err result = found->second->close();
                    if (result != errors::NONE)
                        return result;
                }
                _projects.erase(found);
                return errors::NONE;
            }

            F_err close()
            {
                F_err result = errors::NONE;
                for (auto& entry : _projects)
                    if (entry.second->isOpen() && entry.second->close() != errors::NONE)
                        result = errors::FAILED_CLOSE_PROJECT;
                return result;
            }
    };
}

#endif
