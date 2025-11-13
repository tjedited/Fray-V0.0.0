/* ipc.cpp */

#include "ipc.hpp"

F_void fray::ipc::TCPServer::setPort(F_ushort port)
{
    char buffer[16];
    std::snprintf(buffer, sizeof(buffer), "%hu", port);

    fray::log::engineInfo(buffer);
}