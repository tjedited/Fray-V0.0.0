#include "fray/fray_manager.hpp"
#include "fray/ipc_manager.hpp"

#include <cassert>
#include <chrono>
#include <filesystem>
#include <future>
#include <memory>

namespace fs = std::filesystem;
using namespace std::chrono_literals;

void dispatchFromOtherTranslationUnit(fray::FrayManager& app, const fray::message::InData& incoming,
                                      fray::ipc::IPCManager& ipc);

int main(int argc, char** argv)
{
    assert(argc == 2);
    fs::current_path(argv[1]);
    fray::threads::ThreadManager threads;
    fray::FrayManager app(threads);
    auto ipc = std::make_unique<fray::ipc::IPCManager>(threads, app);

    std::promise<void> blocked;
    std::promise<void> release;
    auto released = release.get_future().share();
    assert(app.postApplication([&] { blocked.set_value(); released.wait(); }));
    blocked.get_future().wait();

    fray::ProjectOpenRequest request;
    request.set_name("Pending");
    const std::string payload = request.SerializeAsString();
    fray::message::Prefix prefix;
    prefix.destinationKind = fray::PROCESS_KIND_ENGINE;
    prefix.senderKind = fray::PROCESS_KIND_ELECTRON_RENDERER;
    prefix.commandId = fray::COMMAND_OPEN_PROJECT;
    fray::Header header;
    header.set_message_id(42);
    header.set_payload_type(fray::PAYLOAD_TYPE_PROTOBUF);
    header.set_message_type(fray::MESSAGE_TYPE_PROJECT_OPEN_REQUEST);
    auto bytes = std::make_shared<std::vector<F_uchar>>();
    assert(fray::message::buildFrame(prefix, header, reinterpret_cast<const F_uchar*>(payload.data()),
                                     payload.size(), *bytes) == fray::errors::NONE);
    fray::message::InData incoming;
    assert(fray::message::parseFrame(bytes, incoming) == fray::errors::NONE);
    incoming.prefix.commandId = fray::COMMAND_TEST;
    app.handleApplicationMessage(incoming, *ipc);
    incoming.prefix.commandId = fray::COMMAND_OPEN_PROJECT;
    dispatchFromOtherTranslationUnit(app, incoming, *ipc);

    auto shuttingDown = std::async(std::launch::async, [&] { ipc.reset(); });
    assert(shuttingDown.wait_for(100ms) == std::future_status::timeout);
    release.set_value();
    assert(shuttingDown.wait_for(10s) == std::future_status::ready);
    shuttingDown.get();

    assert(!fs::exists("Pending.fry"));
    assert(fs::is_regular_file("Pending/Pending.sqlite"));
    assert(!fs::exists("Pending.lock"));
    assert(threads.runningNames().empty());
    assert(app.openProject("AfterShutdown.fry").get() == fray::errors::FAILED_OPEN_PROJECT);
}
