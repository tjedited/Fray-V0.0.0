#include "fray/fray_manager_message.hpp"

void dispatchFromOtherTranslationUnit(fray::FrayManager& app, const fray::message::InData& incoming,
                                      fray::ipc::IPCManager& ipc)
{
    app.handleApplicationMessage(incoming, ipc);
}
