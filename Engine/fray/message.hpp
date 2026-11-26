/* message.hpp */

#ifndef _FRAY_MESSAGE_HPP_
#define _FRAY_MESSAGE_HPP_

#include <algorithm>
#include <atomic>
#include <chrono>
#include <cstddef>
#include <cstdint>
#include <limits>
#include <memory>
#include <string>
#include <vector>

#include "errors.hpp"
#include "fray.pb.h"
#include "types.hpp"

// A frame is three separate sections:
//   [routing prefix: fixed binary] [Header: protobuf] [payload: opaque bytes]
// Routers read only the prefix. The header is parsed once by the receiving process.
namespace fray
{
    namespace message
    {
        constexpr F_uchar PREFIX_VERSION = 1;
        constexpr size_t PREFIX_SIZE = 23;
        // Largest allowed value of the prefix length field (header + payload). Checked before any buffer is allocated.
        constexpr F_ulong MAX_FRAME_LENGTH = 16 * 1024 * 1024;

        // All integers are big-endian on the wire. Layout:
        //  0 version | 1 destinationKind | 2-5 destinationId | 6 senderKind | 7-10 senderId
        //  11-14 commandId | 15-18 length | 19-22 headerLength
        struct Prefix
        {
            F_uchar version = PREFIX_VERSION;
            ProcessKind destinationKind = PROCESS_KIND_UNSPECIFIED;
            F_ulong destinationId = 0; // 0 = default or broadcast
            ProcessKind senderKind = PROCESS_KIND_UNSPECIFIED;
            F_ulong senderId = 0;
            F_ulong commandId = 0; // 0 = none
            F_ulong length = 0;    // Bytes after the prefix (header + payload)
            F_ulong headerLength = 0;
        };

        // A parsed message. The payload is a view into the frame, which this keeps alive.
        struct InData
        {
            Prefix prefix;
            Header header;
            std::shared_ptr<const std::vector<F_uchar>> frame;

            const F_uchar *payload() const { return frame->data() + PREFIX_SIZE + prefix.headerLength; }
            size_t payloadSize() const { return prefix.length - prefix.headerLength; }
        };

        namespace detail
        {
            inline void put32(F_uchar *out, F_ulong v)
            {
                out[0] = static_cast<F_uchar>(v >> 24);
                out[1] = static_cast<F_uchar>(v >> 16);
                out[2] = static_cast<F_uchar>(v >> 8);
                out[3] = static_cast<F_uchar>(v);
            }

            inline F_ulong get32(const F_uchar *in)
            {
                return (static_cast<F_ulong>(in[0]) << 24) | (static_cast<F_ulong>(in[1]) << 16) |
                       (static_cast<F_ulong>(in[2]) << 8) | static_cast<F_ulong>(in[3]);
            }
        }

        inline void encodePrefix(const Prefix &p, F_uchar *out)
        {
            out[0] = p.version;
            out[1] = static_cast<F_uchar>(p.destinationKind);
            detail::put32(out + 2, p.destinationId);
            out[6] = static_cast<F_uchar>(p.senderKind);
            detail::put32(out + 7, p.senderId);
            detail::put32(out + 11, p.commandId);
            detail::put32(out + 15, p.length);
            detail::put32(out + 19, p.headerLength);
        }

        inline F_err decodePrefix(const F_uchar *data, size_t size, Prefix &out)
        {
            if (size < PREFIX_SIZE)
                return errors::INVALID_MESSAGE;
            if (data[0] != PREFIX_VERSION)
                return errors::UNSUPPORTED_MESSAGE_VERSION;

            Prefix p;
            p.version = data[0];
            p.destinationKind = static_cast<ProcessKind>(data[1]);
            p.destinationId = detail::get32(data + 2);
            p.senderKind = static_cast<ProcessKind>(data[6]);
            p.senderId = detail::get32(data + 7);
            p.commandId = detail::get32(data + 11);
            p.length = detail::get32(data + 15);
            p.headerLength = detail::get32(data + 19);
            if (p.headerLength > p.length)
                return errors::INVALID_MESSAGE;
            if (p.length > MAX_FRAME_LENGTH)
                return errors::MESSAGE_TOO_LARGE;

            out = p;
            return errors::NONE;
        }

        // Builds a full frame. The prefix's length fields are filled in from the header and payload.
        inline F_err buildFrame(Prefix prefix, const Header &header, const F_uchar *payload, size_t payloadSize,
                                std::vector<F_uchar> &out)
        {
            const size_t headerSize = header.ByteSizeLong();
            if (headerSize > static_cast<size_t>(std::numeric_limits<int>::max()) ||
                payloadSize > UINT32_MAX - headerSize || (payloadSize && !payload))
                return errors::INVALID_MESSAGE;
            if (headerSize + payloadSize > MAX_FRAME_LENGTH)
                return errors::MESSAGE_TOO_LARGE;

            prefix.length = static_cast<F_ulong>(headerSize + payloadSize);
            prefix.headerLength = static_cast<F_ulong>(headerSize);

            std::vector<F_uchar> frame(PREFIX_SIZE + headerSize + payloadSize);
            encodePrefix(prefix, frame.data());
            if (!header.SerializeToArray(frame.data() + PREFIX_SIZE, static_cast<int>(headerSize)))
                return errors::INVALID_MESSAGE;
            if (payloadSize > 0)
                std::copy(payload, payload + payloadSize, frame.begin() + PREFIX_SIZE + headerSize);

            out = std::move(frame);
            return errors::NONE;
        }

        inline const char *processName(ProcessKind kind)
        {
            switch (kind)
            {
            case PROCESS_KIND_ENGINE: return "Engine";
            case PROCESS_KIND_ENGINE_PLUGIN: return "Engine Plugin";
            case PROCESS_KIND_ELECTRON_MAIN: return "Electron Main";
            case PROCESS_KIND_ELECTRON_RENDERER: return "Electron Renderer";
            case PROCESS_KIND_ELECTRON_PLUGIN: return "Electron Plugin";
            case PROCESS_KIND_BROADCAST: return "Everyone";
            default: return "Unknown";
            }
        }

        // Message IDs are unique per sender, so every engine message takes its ID from here.
        inline uint64_t nextMessageId()
        {
            static std::atomic<uint64_t> next{1};
            return next.fetch_add(1);
        }

        // Builds a complete frame sent by the engine. destinationId 0 means the default instance.
        // ttlMs is how long a router may hold the message while its destination is not ready; 0 means forever.
        inline std::shared_ptr<const std::vector<F_uchar>> makeEngineFrame(
            ProcessKind destination, F_ulong destinationId, F_ulong command,
            PayloadType payloadType = PAYLOAD_TYPE_NONE, const std::string &payload = "", uint32_t ttlMs = 0,
            MessageType messageType = MESSAGE_TYPE_NONE)
        {
            Prefix prefix;
            prefix.destinationKind = destination;
            prefix.destinationId = destinationId;
            prefix.senderKind = PROCESS_KIND_ENGINE;
            prefix.commandId = command;
            Header header;
            header.set_protocol_version(1);
            header.set_message_id(nextMessageId());
            header.set_timestamp(std::chrono::duration_cast<std::chrono::milliseconds>(
                std::chrono::system_clock::now().time_since_epoch()).count());
            header.set_sender_name(processName(PROCESS_KIND_ENGINE));
            header.set_destination_name(processName(destination));
            header.set_payload_type(payloadType);
            header.set_message_type(messageType);
            header.set_ttl_ms(ttlMs);
            auto frame = std::make_shared<std::vector<F_uchar>>();
            const F_err err = buildFrame(prefix, header, reinterpret_cast<const F_uchar *>(payload.data()),
                                         payload.size(), *frame);
            if (err != errors::NONE)
                return nullptr;
            return frame;
        }

        // Parses the header of a complete frame. The payload is not read or copied.
        inline F_err parseFrame(std::shared_ptr<const std::vector<F_uchar>> frame, InData &out)
        {
            if (!frame)
                return errors::INVALID_MESSAGE;

            InData in;
            if (F_err err = decodePrefix(frame->data(), frame->size(), in.prefix))
                return err;
            if (frame->size() != PREFIX_SIZE + static_cast<size_t>(in.prefix.length))
                return errors::INVALID_MESSAGE;
            if (in.prefix.headerLength > static_cast<F_ulong>(std::numeric_limits<int>::max()))
                return errors::INVALID_MESSAGE;
            if (!in.header.ParseFromArray(frame->data() + PREFIX_SIZE, static_cast<int>(in.prefix.headerLength)))
                return errors::INVALID_MESSAGE;

            in.frame = std::move(frame);
            out = std::move(in);
            return errors::NONE;
        }
    }
}

#endif
