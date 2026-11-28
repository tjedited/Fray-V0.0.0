#include "fray/project_message_handler.hpp"
#include "fray/fray_message_handler.hpp"

void dispatchFromOtherTranslationUnit(fray::FrayManager& app, const fray::message::InData& incoming,
                                      fray::ipc::IPCManager& ipc)
{
    app.handleApplicationMessage(incoming, ipc);
}
