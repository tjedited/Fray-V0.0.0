#ifndef FRAY_MANAGER_MESSAGE_HPP
#define FRAY_MANAGER_MESSAGE_HPP

#include "fray_manager.hpp"
#include "ipc_manager.hpp"

#include <algorithm>
#include <cctype>

namespace fray
{
    inline void FrayManager::handleApplicationMessage(
        const message::InData& incoming,
        ipc::IPCManager& ipc)
    {
        const auto& prefix = incoming.prefix;
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
