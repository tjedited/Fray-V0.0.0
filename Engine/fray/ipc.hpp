/* ipc.hpp */

#ifndef _FRAY_IPC_HPP_
#define _FRAY_IPC_HPP_

#include <boost/asio.hpp>
#include <boost/asio/strand.hpp>

#include <atomic>
#include <condition_variable>
#include <deque>
#include <functional>
#include <iostream>
#include <memory>
#include <mutex>
#include <queue>
#include <set>
#include <string>
#include <thread>
#include <vector>

namespace fray
{
    namespace ipc
    {
        class TCPServer : public std::enable_shared_from_this<TCPServer>
        {
        private:
            boost::asio::ip::tcp::acceptor _boostAcceptor;
            boost::asio::steady_timer _boostAcceptTimer;
            F_bool _accepting = true;
            std::set<std::shared_ptr<boost::asio::ip::tcp::socket>> _boostSessions;

            F_void accept()
            {
                if (!_accepting)
                    return;

                auto self = shared_from_this();

                _boostAcceptTimer.expires_after(std::chrono::seconds(10));
                _boostAcceptTimer.async_wait(
                    [this, self](const boost::system::error_code &ec)
                    {
                        if (!ec)
                        {
                            fray::log::engineWarn("Accept timed out!");
                            _accepting = false;
                            _boostAcceptor.cancel();

                            if (_boostSessions.empty())
                            {
                                fray::log::engineWarn("No clients connected. Destroying TCPServer.");
                            }
                        }
                    });

                _boostAcceptor.async_accept(
                    [this, self](boost::system::error_code ec, boost::asio::ip::tcp::socket socket)
                    {
                        _boostAcceptTimer.cancel(); // Cancel timer when accept completes

                        if (!_accepting)
                            return;

                        if (!ec)
                        {
                            fray::log::engineInfo("Client connected!");
                            auto session = std::make_shared<boost::asio::ip::tcp::socket>(std::move(socket));
                            _boostSessions.insert(session);
                            startRead(session);
                        }
                        else if (ec == boost::asio::error::operation_aborted)
                        {
                            fray::log::engineWarn("Accept operation aborted (likely due to timeout).");
                        }
                        else
                        {
                            fray::log::engineError("Boost accept error: %s", ec.message().c_str());
                        }

                        // Only keep accepting if not timed out
                        if (_accepting)
                            accept();
                    });
            }

            // Add this helper function to TCPServer:
            F_void startRead(std::shared_ptr<boost::asio::ip::tcp::socket> session)
            {
                auto headerBuf = std::make_shared<std::array<char, 4>>();
                boost::asio::async_read(
                    *session, boost::asio::buffer(*headerBuf),
                    [this, session, headerBuf](boost::system::error_code ec, std::size_t)
                    {
                        if (!ec)
                        {
                            uint32_t msgLen = 0;
                            std::memcpy(&msgLen, headerBuf->data(), 4);
                            msgLen = ntohl(msgLen); // Convert from network byte order

                            auto msgBuf = std::make_shared<std::vector<char>>(msgLen);
                            boost::asio::async_read(
                                *session, boost::asio::buffer(*msgBuf),
                                [this, session, msgBuf](boost::system::error_code ec2, std::size_t)
                                {
                                    if (!ec2)
                                    {
                                        std::string line(msgBuf->data(), msgBuf->size());
                                        fray::log::engineInfo("Received from client: %s", line.c_str());

                                        // Echo back with header
                                        uint32_t len = htonl(line.size());
                                        std::vector<char> echoMsg(4 + line.size());
                                        std::memcpy(echoMsg.data(), &len, 4);
                                        std::memcpy(echoMsg.data() + 4, line.data(), line.size());

                                        boost::asio::async_write(
                                            *session, boost::asio::buffer(echoMsg),
                                            [this, session](boost::system::error_code write_ec, std::size_t)
                                            {
                                                if (!write_ec)
                                                    startRead(session);
                                                else
                                                    _boostSessions.erase(session);
                                            });
                                    }
                                });
                        }
                    });
            }

        public:
            TCPServer(
                boost::asio::io_context &boostIOContext,
                F_ushort port)
                : _boostAcceptor(
                      boostIOContext,
                      boost::asio::ip::tcp::endpoint(
                          boost::asio::ip::tcp::v4(),
                          port)),
                  _boostAcceptTimer(boostIOContext)
            {
                fray::log::engineInfo("Constructed TCPServer.");
            }

            ~TCPServer()
            {
                fray::log::engineInfo("Destroyed TCPServer.");
            }

            F_void start()
            {
                accept();
            }
        };

        typedef std::shared_ptr<TCPServer> TCPServerSP;

        /** IPCManager
         * Responsible for managing boost asio io_context,
         * instances of TCPServers and WebSocketServers
         */
        class IPCManager
        {
        private:
            std::vector<TCPServerSP> _TCPServerSPs;
            boost::asio::io_context _boostIOContext;

        public:
            IPCManager()
            {
                fray::log::engineInfo("Constructed IPCManager.");
            }

            ~IPCManager()
            {
                // TODO: Gracefully shut down servers.
                _TCPServerSPs.clear();
                fray::log::engineInfo("Destroyed IPCManager.");
            }

            TCPServerSP createTCPServer(
                F_ushort port)
            {
                TCPServerSP server = std::make_shared<TCPServer>(_boostIOContext, port);
                server->start();
                _TCPServerSPs.push_back(server);
                return server;
            }

            /** BLOCKING!
             * The run() function blocks until all work has
             * finished and there are no more handlers to be
             * dispatched, or until the io_context has been
             * stopped.
             */
            F_void run()
            {
                _boostIOContext.run();
            }
        };
    }
}

#endif