#include "fray/message.hpp"

#include <cassert>
#include <string>

int main()
{
    fray::message::FrameBuilder builder;
    fray::message::FrameOptions options{fray::PROCESS_KIND_ELECTRON_MAIN, fray::COMMAND_TEST};
    options.destinationId = 7;
    options.payload = "hello";
    options.payloadType = fray::PAYLOAD_TYPE_JSON;
    options.targetProject = "Project";
    options.ttlMs = 5000;

    std::shared_ptr<const std::vector<F_uchar>> frame;
    assert(builder.build(options, frame) == fray::errors::NONE);
    fray::message::InData decoded;
    assert(fray::message::parseFrame(frame, decoded) == fray::errors::NONE);
    assert(decoded.prefix.senderKind == fray::PROCESS_KIND_ENGINE);
    assert(decoded.prefix.destinationId == 7);
    assert(decoded.header.target_project() == "Project");
    assert(decoded.header.ttl_ms() == 5000);
    assert(decoded.header.payload_type() == fray::PAYLOAD_TYPE_JSON);
    assert(std::string(reinterpret_cast<const char *>(decoded.payload()), decoded.payloadSize()) == "hello");

    options.payloadType = fray::PAYLOAD_TYPE_NONE;
    assert(builder.build(options, frame) == fray::errors::INVALID_MESSAGE);
}
