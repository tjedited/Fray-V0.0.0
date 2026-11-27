#include "fray/fray_manager.hpp"
#include "fray/ipc_manager.hpp"

#include <boost/asio.hpp>
#include <cassert>
#include <chrono>
#include <future>
#include <thread>

using namespace std::chrono_literals;
using boost::asio::ip::tcp;

static void sendFrame(
    tcp::socket& socket,
    F_ulong command,
    const std::string& payload = {})
{
    fray::message::Prefix prefix;
    prefix.destinationKind = fray::PROCESS_KIND_ENGINE;
    prefix.senderKind = fray::PROCESS_KIND_ELECTRON_RENDERER;
    prefix.commandId = command;
    fray::Header header;
    header.set_message_id(7);
    if (!payload.empty())
    {
        header.set_payload_type(fray::PAYLOAD_TYPE_PROTOBUF);
        header.set_message_type(fray::MESSAGE_TYPE_PROMPT_RESPONSE);
    }
    std::vector<F_uchar> frame;
    assert(fray::message::buildFrame(prefix, header, reinterpret_cast<const F_uchar*>(payload.data()), payload.size(),
                                     frame) == fray::errors::NONE);
    boost::asio::write(socket, boost::asio::buffer(frame));
}

static fray::message::InData readPrompt(
    tcp::socket& socket)
{
    socket.non_blocking(true);
    std::vector<F_uchar> bytes;
    const auto deadline = std::chrono::steady_clock::now() + 5s;
    while (std::chrono::steady_clock::now() < deadline)
    {
        std::array<F_uchar, 4096> chunk;
        boost::system::error_code error;
        const auto count = socket.read_some(boost::asio::buffer(chunk), error);
        if (!error) bytes.insert(bytes.end(), chunk.begin(), chunk.begin() + count);
        else assert(error == boost::asio::error::would_block || error == boost::asio::error::try_again);
        while (bytes.size() >= fray::message::PREFIX_SIZE)
        {
            fray::message::Prefix prefix;
            assert(fray::message::decodePrefix(bytes.data(), bytes.size(), prefix) == fray::errors::NONE);
            const auto length = fray::message::PREFIX_SIZE + prefix.length;
            if (bytes.size() < length) break;
            auto frame = std::make_shared<const std::vector<F_uchar>>(bytes.begin(), bytes.begin() + length);
            bytes.erase(bytes.begin(), bytes.begin() + length);
            if (prefix.commandId == fray::COMMAND_PROMPT_REQUEST)
            {
                fray::message::InData result;
                assert(fray::message::parseFrame(frame, result) == fray::errors::NONE);
                socket.non_blocking(false);
                return result;
            }
        }
        std::this_thread::sleep_for(10ms);
    }
    assert(false && "Engine prompt did not arrive.");
    return {};
}

int main()
{
    fray::FrayManager app;
    auto ipc = std::make_unique<fray::ipc::IPCManager>(app);
    const auto server = ipc->createTCPServer(0);
    ipc->start();
    boost::asio::io_context io;
    tcp::socket socket(io);
    socket.connect({boost::asio::ip::make_address("127.0.0.1"), server->port()});
    sendFrame(socket, fray::COMMAND_READY);

    fray::PromptRequest request;
    request.set_title("Engine choice");
    request.set_dismissible(false);
    auto* button = request.add_buttons();
    button->set_label("Yes");
    button->set_value("yes");
    std::promise<fray::PromptResponse> completed;
    auto completion = completed.get_future();
    assert(app.requestPrompt(*ipc, request, [&](const fray::PromptResponse& result) { completed.set_value(result); }));
    const auto sent = readPrompt(socket);
    assert(sent.prefix.destinationKind == fray::PROCESS_KIND_ELECTRON_RENDERER);
    fray::PromptResponse response;
    response.set_request_id(sent.header.message_id());
    response.set_value("invalid");
    sendFrame(socket, fray::COMMAND_PROMPT_RESPONSE, response.SerializeAsString());
    assert(completion.wait_for(100ms) == std::future_status::timeout);
    response.set_value("yes");
    sendFrame(socket, fray::COMMAND_PROMPT_RESPONSE, response.SerializeAsString());
    assert(completion.wait_for(5s) == std::future_status::ready);
    assert(completion.get().value() == "yes");

    std::promise<fray::PromptResponse> cancelled;
    auto cancellation = cancelled.get_future();
    assert(app.requestPrompt(*ipc, request, [&](const fray::PromptResponse& result) { cancelled.set_value(result); }));
    ipc.reset();
    assert(cancellation.wait_for(5s) == std::future_status::ready);
    assert(cancellation.get().error() == "Application is shutting down.");
}
