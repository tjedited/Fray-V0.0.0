/* message_router.hpp */

#ifndef _FRAY_MESSAGE_ROUTER_HPP_
#define _FRAY_MESSAGE_ROUTER_HPP_

#include "log_manager.hpp"
#include "message.hpp"

namespace fray
{
    namespace routing
    {
        enum class Destination
        {
            engine,
            unsupported
        };

        inline Destination routeMessage(
            const message::Prefix& prefix)
        {
            // The engine hears every broadcast. It never relays one: the only peer it talks to is Electron Main.
            if (prefix.destinationKind == PROCESS_KIND_ENGINE || prefix.destinationKind == PROCESS_KIND_BROADCAST)
                return Destination::engine;
            log::engineWarn("Cannot route message: unsupported destination kind=%u id=%u.",
                static_cast<unsigned>(prefix.destinationKind), prefix.destinationId);
            return Destination::unsupported;
        }

        inline void handleEngineMessage(
            const message::InData& incomingMessage)
        {
            const auto& prefix = incomingMessage.prefix;
            const auto& header = incomingMessage.header;
            if (prefix.commandId != COMMAND_PING && prefix.commandId != COMMAND_PONG)
                log::engineInfo("Received frame: command=%u sender=%s destination=%s protocol=%u message_id=%llu timestamp=%llu flags=%u payload_type=%d message_type=%d payload_bytes=%zu frame_bytes=%zu.",
                    prefix.commandId, header.sender_name().c_str(), header.destination_name().c_str(), header.protocol_version(),
                    static_cast<unsigned long long>(header.message_id()), static_cast<unsigned long long>(header.timestamp()),
                    header.flags(), static_cast<int>(header.payload_type()), static_cast<int>(header.message_type()),
                    incomingMessage.payloadSize(), incomingMessage.frame->size());
        }
    }
}

#endif
