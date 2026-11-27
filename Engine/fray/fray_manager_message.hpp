#ifndef FRAY_MANAGER_MESSAGE_HPP
#define FRAY_MANAGER_MESSAGE_HPP

#include "fray_manager.hpp"
#include "ipc_manager.hpp"

#include <algorithm>
#include <cctype>

namespace fray
{
    inline bool FrayManager::requestPrompt(
        ipc::IPCManager& ipc,
        const PromptRequest& request,
        std::function<void(const PromptResponse&)> callback)
    {
        const auto blank = [](const std::string& value)
        {
            return std::all_of(value.begin(), value.end(), [](unsigned char ch) { return std::isspace(ch); });
        };
        if (!callback || blank(request.title()) || request.buttons().empty() ||
            std::any_of(request.buttons().begin(), request.buttons().end(),
                        [&](const PromptButton& button) { return blank(button.label()); }))
        {
            log::engineError("Cannot request prompt: title, labeled buttons and callback are required.");
            return false;
        }
        message::FrameOptions options{PROCESS_KIND_ELECTRON_RENDERER, COMMAND_PROMPT_REQUEST};
        options.payload = request.SerializeAsString();
        options.payloadType = PAYLOAD_TYPE_PROTOBUF;
        options.messageType = MESSAGE_TYPE_PROMPT_REQUEST;
        ipc::Frame frame;
        const F_err built = message::FrameBuilder{}.build(options, frame);
        message::InData parsed;
        if (built != errors::NONE || message::parseFrame(frame, parsed) != errors::NONE)
        {
            log::engineError("Cannot build prompt request.");
            return false;
        }
        std::lock_guard<std::mutex> lock(_promptMutex);
        if (_promptClosing)
        {
            log::engineError("Cannot request prompt: application is shutting down.");
            return false;
        }
        const uint64_t id = parsed.header.message_id();
        _pendingPrompts.emplace(id, PendingPrompt{request, std::move(callback)});
        if (!ipc.send(frame))
        {
            _pendingPrompts.erase(id);
            return false;
        }
        return true;
    }

    inline void FrayManager::handleApplicationMessage(
        const message::InData& incoming,
        ipc::IPCManager& ipc)
    {
        const auto& prefix = incoming.prefix;
        if (prefix.commandId == COMMAND_PROMPT_RESPONSE)
        {
            PromptResponse response;
            if (prefix.destinationKind != PROCESS_KIND_ENGINE ||
                prefix.senderKind != PROCESS_KIND_ELECTRON_RENDERER || prefix.senderId != 0 ||
                incoming.header.payload_type() != PAYLOAD_TYPE_PROTOBUF ||
                incoming.header.message_type() != MESSAGE_TYPE_PROMPT_RESPONSE ||
                !response.ParseFromArray(incoming.payload(), static_cast<int>(incoming.payloadSize())))
            {
                log::engineError("Cannot handle prompt response: invalid sender or payload.");
                return;
            }
            std::lock_guard<std::mutex> lock(_promptMutex);
            const auto found = _pendingPrompts.find(response.request_id());
            if (found == _pendingPrompts.end())
            {
                log::engineError("Cannot handle prompt response: unknown request.");
                return;
            }
            const auto& request = found->second.request;
            const bool validChoice = std::any_of(request.buttons().begin(), request.buttons().end(),
                [&](const PromptButton& button) { return button.value() == response.value(); });
            if (response.error().empty() &&
                ((response.dismissed() && request.has_dismissible() && !request.dismissible()) ||
                 (!response.dismissed() && !validChoice)))
            {
                log::engineError("Cannot handle prompt response: invalid choice.");
                return;
            }
            const auto callback = found->second.callback;
            if (!postApplication([callback, response] { callback(response); }))
            {
                log::engineError("Cannot handle prompt response: application thread is shutting down.");
                return;
            }
            _pendingPrompts.erase(found);
            return;
        }
        if (prefix.commandId == COMMAND_CLOSE_PROJECT)
        {
            if (prefix.senderKind != PROCESS_KIND_ELECTRON_MAIN &&
                prefix.senderKind != PROCESS_KIND_ELECTRON_RENDERER)
            {
                log::engineError("Cannot close project: unsupported sender.");
                return;
            }
            const auto sendResult = [&ipc, sender = prefix.senderKind, senderId = prefix.senderId,
                                     requestId = incoming.header.message_id()](const std::string& name, F_err result,
                                                                              bool packaged)
            {
                ProjectCloseResult payload;
                payload.set_request_id(requestId);
                payload.set_name(name);
                payload.set_success(result == errors::NONE);
                payload.set_packaged(packaged);
                if (result == errors::PROJECT_NOT_FOUND)
                    payload.set_error("No matching project is open.");
                else if (result != errors::NONE)
                    payload.set_error("Could not close the project. See the Engine log for details.");
                message::FrameOptions options{sender, COMMAND_PROJECT_CLOSE_RESULT, senderId};
                options.payload = payload.SerializeAsString();
                options.payloadType = PAYLOAD_TYPE_PROTOBUF;
                options.messageType = MESSAGE_TYPE_PROJECT_CLOSE_RESULT;
                ipc.sendBuilt(options);
            };
            ProjectCloseRequest request;
            const std::string target = incoming.header.target_project();
            if (prefix.destinationKind != PROCESS_KIND_ENGINE ||
                incoming.header.payload_type() != PAYLOAD_TYPE_PROTOBUF ||
                incoming.header.message_type() != MESSAGE_TYPE_PROJECT_CLOSE_REQUEST ||
                !request.ParseFromArray(incoming.payload(), static_cast<int>(incoming.payloadSize())) ||
                (!target.empty() && !ProjectManager::validProjectName(target)))
            {
                log::engineError("Cannot close project: invalid request.");
                sendResult(target, errors::INVALID_MESSAGE, false);
                return;
            }
            requestCloseProject(target, request.package(), sendResult);
            return;
        }
        if (prefix.commandId == COMMAND_CREATE_PROJECT)
        {
            if (prefix.senderKind != PROCESS_KIND_ELECTRON_MAIN &&
                prefix.senderKind != PROCESS_KIND_ELECTRON_RENDERER)
            {
                log::engineError("Cannot create project: unsupported sender.");
                return;
            }
            const auto sendResult = [&ipc, sender = prefix.senderKind, senderId = prefix.senderId,
                                     requestId = incoming.header.message_id()](const std::string& path, F_err result,
                                                                              bool creating)
            {
                ProjectCreateResult payload;
                payload.set_request_id(requestId);
                payload.set_path(path);
                if (result == errors::NONE)
                    payload.set_status(creating ? PROJECT_CREATE_SUCCEEDED : PROJECT_OPEN_SUCCEEDED);
                else if (result == errors::PROJECT_FOLDER_EXISTS)
                    payload.set_status(PROJECT_FOLDER_CONFLICT);
                else if (result == errors::PROJECT_ARCHIVE_EXISTS)
                    payload.set_status(PROJECT_ARCHIVE_CONFLICT);
                else if (result == errors::PROJECT_BOTH_EXIST || result == errors::PROJECT_CONFLICT)
                    payload.set_status(PROJECT_BOTH_CONFLICT);
                else if (result == errors::PROJECT_ALREADY_OPEN)
                    payload.set_error("A project with this name is already open.");
                else if (result == errors::PROJECT_NOT_FOUND)
                    payload.set_error("The selected project no longer exists.");
                else if (result == errors::INVALID_PROJECT_DATABASE)
                {
                    payload.set_status(PROJECT_INVALID_DATABASE);
                    payload.set_error("The selected project has no valid Fray database.");
                }
                else if (result == errors::DATABASE_CONFLICT)
                    payload.set_error("The project has multiple possible databases.");
                else if (result == errors::PROJECT_DATABASE_OCCUPIED)
                    payload.set_error("A file already occupies the project database path; it was not overwritten.");
                else if (result == errors::INVALID_MESSAGE)
                    payload.set_error("The project path or request is invalid.");
                else
                    payload.set_error("Could not open the project. See the Engine log for details.");
                message::FrameOptions options{sender, COMMAND_PROJECT_CREATE_RESULT, senderId};
                options.payload = payload.SerializeAsString();
                options.payloadType = PAYLOAD_TYPE_PROTOBUF;
                options.messageType = MESSAGE_TYPE_PROJECT_CREATE_RESULT;
                ipc.sendBuilt(options);
            };
            ProjectCreateRequest request;
            if (prefix.destinationKind != PROCESS_KIND_ENGINE ||
                incoming.header.payload_type() != PAYLOAD_TYPE_PROTOBUF ||
                incoming.header.message_type() != MESSAGE_TYPE_PROJECT_CREATE_REQUEST ||
                !request.ParseFromArray(incoming.payload(), static_cast<int>(incoming.payloadSize())) ||
                !ProjectCreateChoice_IsValid(request.choice()))
            {
                log::engineError("Cannot create project: invalid request.");
                sendResult("", errors::INVALID_MESSAGE, true);
                return;
            }
            const std::string path = request.path();
            const std::filesystem::path target(path);
            if (path.find('\0') != std::string::npos || !target.is_absolute() ||
                !ProjectManager::validProjectName(target.filename().string()))
            {
                log::engineError("Cannot create project: invalid absolute path.");
                sendResult(path, errors::INVALID_MESSAGE, true);
                return;
            }
            const bool creating = request.choice() == PROJECT_CREATE_NEW || request.choice() == PROJECT_CREATE_IN_FOLDER ||
                                  request.choice() == PROJECT_CREATE_IN_FOLDER_RESOLVE;
            const auto choice = request.choice() == PROJECT_OPEN_ARCHIVE || request.choice() == PROJECT_SELECT_ARCHIVE
                                    ? files::ConflictChoice::Archive :
                                request.choice() == PROJECT_OPEN_FOLDER || request.choice() == PROJECT_SELECT_FOLDER ||
                                request.choice() == PROJECT_CREATE_IN_FOLDER_RESOLVE
                                    ? files::ConflictChoice::Folder :
                                files::ConflictChoice::Ask;
            const auto mode = request.choice() == PROJECT_CREATE_IN_FOLDER_RESOLVE ? files::OpenMode::CreateInFolderResolve :
                              request.choice() == PROJECT_CREATE_IN_FOLDER ? files::OpenMode::CreateInFolder :
                              request.choice() == PROJECT_CREATE_NEW ? files::OpenMode::CreateNew :
                              request.choice() == PROJECT_SELECT_ARCHIVE || request.choice() == PROJECT_SELECT_FOLDER
                                  ? files::OpenMode::OpenSelected : files::OpenMode::OpenExisting;
            if (!postApplication([this, path, choice, mode, creating, sendResult]
            {
                (void)openProject(path, choice, [path, creating, sendResult](F_err result)
                                  { sendResult(path, result, creating); }, true, mode);
            }))
            {
                log::engineError("Cannot create project: application thread is shutting down.");
                sendResult(path, errors::FAILED_OPEN_PROJECT, creating);
            }
            return;
        }
        if (prefix.commandId != COMMAND_OPEN_PROJECT)
            return;
        if (prefix.senderKind != PROCESS_KIND_ELECTRON_MAIN &&
            prefix.senderKind != PROCESS_KIND_ELECTRON_RENDERER)
        {
            log::engineError("Cannot open project: unsupported sender.");
            return;
        }

        const auto sendResult = [&ipc, sender = prefix.senderKind, senderId = prefix.senderId,
                                 requestId = incoming.header.message_id()](const std::string& name, F_err result)
        {
            ProjectOpenResult payload;
            payload.set_name(name);
            payload.set_success(result == errors::NONE);
            payload.set_request_id(requestId);
            if (result == errors::PROJECT_ALREADY_OPEN)
                payload.set_error("This project is already open.");
            else if (result == errors::PROJECT_CONFLICT)
                payload.set_error("Both the working folder and archive exist; resolve the conflict before opening.");
            else if (result == errors::DATABASE_CONFLICT)
                payload.set_error("The project has multiple possible databases; resolve the conflict before opening.");
            else if (result == errors::INVALID_MESSAGE)
                payload.set_error("The project name or request is invalid.");
            else if (result != errors::NONE)
                payload.set_error("Could not open the project. See the Engine log for details.");
            message::FrameOptions options{sender, COMMAND_PROJECT_OPEN_RESULT, senderId};
            options.payload = payload.SerializeAsString();
            options.payloadType = PAYLOAD_TYPE_PROTOBUF;
            options.messageType = MESSAGE_TYPE_PROJECT_OPEN_RESULT;
            ipc.sendBuilt(options);
        };

        ProjectOpenRequest request;
        if (prefix.destinationKind != PROCESS_KIND_ENGINE ||
            incoming.header.payload_type() != PAYLOAD_TYPE_PROTOBUF ||
            incoming.header.message_type() != MESSAGE_TYPE_PROJECT_OPEN_REQUEST ||
            !request.ParseFromArray(incoming.payload(), static_cast<int>(incoming.payloadSize())))
        {
            log::engineError("Cannot open project: invalid request.");
            sendResult("", errors::INVALID_MESSAGE);
            return;
        }
        const std::string name = request.name();
        if (!ProjectManager::validProjectName(name) ||
            std::all_of(name.begin(), name.end(), [](unsigned char ch) { return std::isspace(ch); }))
        {
            log::engineError("Cannot open project: invalid project name.");
            sendResult(name, errors::INVALID_MESSAGE);
            return;
        }
        if (!postApplication([this, name, sendResult]
        {
            (void)openProject(name + ".fry", files::ConflictChoice::Ask,
                              [name, sendResult](F_err result) { sendResult(name, result); }, true);
        }))
        {
            log::engineError("Cannot open project: application thread is shutting down.");
            sendResult(name, errors::FAILED_OPEN_PROJECT);
        }
    }
}

#endif
