/* ipc.hpp */

#ifndef _FRAY_IPC_HPP_
#define _FRAY_IPC_HPP_

#include <cstdio>
#include <iostream>
#include <atomic>
#include <thread>

#include <boost/asio.hpp>

#include "../fray/fray.hpp"
#include "../log/log.hpp"

namespace fray::ipc
{
    typedef F_err (*senderLoop)();

    class TCPServer
    {
        public:
            F_void setPort(F_ushort port);
        private:
    };

    class IPCManager
    {

    };
}

#endif