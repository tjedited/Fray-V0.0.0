#ifndef FRAY_PROJECT_MESSAGE_HANDLER_HPP
#define FRAY_PROJECT_MESSAGE_HANDLER_HPP

#include "message.hpp"
#include "project_manager.hpp"
#include "fray_manager.hpp"
#include "ipc_manager.hpp"

namespace fray
{
    // Called on the selected project's queue.
    inline F_err ProjectManager::handleProjectMessage(
        const ProjectCloseRequest& request,
        bool& packaged)
    {
        return close(request.package(), &packaged);
    }

    inline void FrayManager::handleProjectMessage(
        const message::InData& incoming,
        ipc::IPCManager& ipc)
    {
        const auto& prefix = incoming.prefix;
        if (prefix.commandId != COMMAND_CLOSE_PROJECT)
        {
            log::engineError("Cannot handle project message: unsupported command.");
            return;
        }
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
            else if (result == errors::PROJECT_AMBIGUOUS)
                payload.set_error("Multiple projects have this name. Use the full path.");
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
            target.find('\0') != std::string::npos)
        {
            log::engineError("Cannot close project: invalid request.");
            sendResult(target, errors::INVALID_MESSAGE, false);
            return;
        }
        queueProjectClose(target, [request](ProjectManager& project, bool& packaged)
        {
            return project.handleProjectMessage(request, packaged);
        }, sendResult);
    }
}

#endif
