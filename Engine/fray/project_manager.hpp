#ifndef FRAY_PROJECT_MANAGER_HPP
#define FRAY_PROJECT_MANAGER_HPP

#include <memory>
#include <stdexcept>
#include <string>
#include <unordered_map>

#include "file_manager.hpp"
#include "state_manager.hpp"

namespace fray
{
    class ProjectManager
    {
        private:
            files::FileManager _files;
            std::unordered_map<std::string, std::unique_ptr<state::StateManager>> _states;
            std::string _applicationId;
            bool _open = false;
            bool _archiveComplete = false;

        public:
            ProjectManager() = default;
            ProjectManager(const ProjectManager&) = delete;
            ProjectManager& operator=(const ProjectManager&) = delete;

            ~ProjectManager()
            {
                if (_open && close() != errors::NONE)
                    log::engineError("Project could not be closed; check its archive and working folder.");
            }

            F_err open(const std::string& path, const std::string& applicationId,
                       files::ConflictChoice choice = files::ConflictChoice::Ask)
            {
                if (_open || _files.isOpen())
                {
                    log::engineError("Cannot open project: manager already has a project.");
                    return errors::FAILED_OPEN_PROJECT;
                }
                const F_err opened = _files.open(path, choice);
                if (opened != errors::NONE)
                    return opened;
                _applicationId = applicationId;
                auto state = std::make_unique<fray::state::StateManager>();
                F_err result = state->open(_files, "Fray", _applicationId);
                if (result == errors::NONE)
                {
                    F_bool exists = false;
                    result = state->contains("project.name", exists);
                    if (result == errors::NONE && !exists)
                        result = state->set("project.name", _files.projectName());
                }
                if (result != errors::NONE)
                {
                    state.reset();
                    if (_files.close() != errors::NONE)
                        log::engineError("Could not release project after opening failed.");
                    _applicationId.clear();
                    return result;
                }
                _states.emplace("Fray", std::move(state));
                _open = true;
                return errors::NONE;
            }

            bool isOpen() const { return _open; }
            const std::string& name() const { return _files.projectName(); }
            const std::string& applicationId() const { return _applicationId; }
            files::FileManager& fileManager() { return _files; }

            F_err openState(const std::string& name)
            {
                if (!_open || _archiveComplete)
                {
                    log::engineError("Cannot open state: project is closed or closing.");
                    return errors::FAILED_OPEN_STORE;
                }
                auto found = _states.find(name);
                if (found != _states.end() && found->second->isOpen())
                    return errors::NONE;
                auto manager = std::make_unique<state::StateManager>();
                const F_err result = manager->open(_files, name, _applicationId);
                if (result != errors::NONE)
                    return result;
                _states[name] = std::move(manager);
                return errors::NONE;
            }

            state::StateManager& state(const std::string& name)
            {
                const auto found = _states.find(name);
                if (!_open || found == _states.end() || !found->second->isOpen())
                    throw std::out_of_range("Project state manager is not open: " + name);
                return *found->second;
            }

            template<typename T>
            F_err set(const std::string& key, const T& value)
            {
                if (!_open || !_states.at("Fray")->isOpen())
                {
                    log::engineError("Cannot save state: project is closed.");
                    return errors::FAILED_SAVE_STATE;
                }
                return _states.at("Fray")->set(key, value);
            }

            template<typename T>
            F_err get(const std::string& key, T& value)
            {
                if (!_open || !_states.at("Fray")->isOpen())
                {
                    log::engineError("Cannot load state: project is closed.");
                    return errors::FAILED_LOAD_STATE;
                }
                return _states.at("Fray")->get(key, value);
            }

            F_err close()
            {
                if (!_open)
                {
                    log::engineError("Cannot close project: project is not open.");
                    return errors::FAILED_CLOSE_PROJECT;
                }
                for (auto& entry : _states)
                    if (entry.second->isOpen() && entry.second->close() != errors::NONE)
                        return errors::FAILED_CLOSE_PROJECT;
                if (!_archiveComplete)
                {
                    if (_files.save() != errors::NONE)
                        return errors::FAILED_SAVE_PROJECT;
                    _archiveComplete = true;
                }
                if (_files.removeWorkingDirectory() != errors::NONE)
                    return errors::FAILED_CLOSE_PROJECT;
                if (_files.close() != errors::NONE)
                    return errors::FAILED_CLOSE_PROJECT;
                _states.clear();
                _applicationId.clear();
                _open = false;
                _archiveComplete = false;
                return errors::NONE;
            }
    };
}

#endif
