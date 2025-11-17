/* ipc.hpp */

#ifndef _FRAY_IPC_HPP_
#define _FRAY_IPC_HPP_

#include <boost/asio.hpp>
#include <boost/asio/steady_timer.hpp>
#include <set>
#include <vector>
#include <algorithm>
#include "log.hpp"
#include "types.hpp"

namespace fray {
namespace ipc {

class IPCManager; // forward

class TCPServer : public std::enable_shared_from_this<TCPServer>
{
private:
    boost::asio::ip::tcp::acceptor _acceptor;
    boost::asio::steady_timer _acceptTimer;
    F_bool _accepting = true;
    F_bool _stopped = false;
    F_ushort _port = 0;
    std::set<std::shared_ptr<boost::asio::ip::tcp::socket>> _sessions;
    IPCManager* _manager = nullptr;

    F_void accept();
    F_void startRead(std::shared_ptr<boost::asio::ip::tcp::socket> session);

public:
    TCPServer(boost::asio::io_context& ctx, F_ushort port, IPCManager* manager)
        : _acceptor(ctx, {boost::asio::ip::tcp::v4(), port}),
          _acceptTimer(ctx),
          _port(port),
          _manager(manager)
    {
        fray::log::engineInfo("Constructed server on port %d.", _port);
    }

    ~TCPServer()
    {
        fray::log::engineInfo("Destroyed TCPServer on port %d.", _port);
    }

    F_void start() { accept(); }
    F_void stop();
    F_ushort port() const { return _port; }
};

using TCPServerSP = std::shared_ptr<TCPServer>;

class IPCManager
{
private:
    boost::asio::io_context _io;
    std::vector<TCPServerSP> _servers;

public:
    IPCManager()
    {
        fray::log::engineInfo("Constructed IPCManager.");
    }

    ~IPCManager()
    {
        for (auto& s : _servers)
            if (s) s->stop();
        _servers.clear();
        fray::log::engineInfo("Destroyed IPCManager.");
    }

    TCPServerSP createTCPServer(F_ushort port)
    {
        auto s = std::make_shared<TCPServer>(_io, port, this);
        s->start();
        _servers.push_back(s);
        return s;
    }

    F_void removeTCPServer(F_ushort port)
    {
        auto it = std::find_if(_servers.begin(), _servers.end(),
            [port](const TCPServerSP& sp){ return sp && sp->port() == port; });
        if (it != _servers.end())
        {
            fray::log::engineInfo("Removing TCPServer on port %d.", port);
            _servers.erase(it);
        }
        // Stop io_context when no servers remain.
        if (_servers.empty())
        {
            fray::log::engineInfo("No servers remaining; stopping io_context.");
            _io.stop();
        }
    }

    F_void run() { _io.run(); }
};

/* ---- TCPServer method definitions ---- */

inline F_void TCPServer::accept()
{
    if (!_accepting || _stopped) return;
    auto self = shared_from_this();

    _acceptTimer.expires_after(std::chrono::seconds(2));
    _acceptTimer.async_wait([this, self](const boost::system::error_code& ec){
        if (!ec && _sessions.empty())
            stop();
    });

    _acceptor.async_accept([this, self](boost::system::error_code ec, boost::asio::ip::tcp::socket sock){
        _acceptTimer.cancel();
        if (_stopped) return;
        if (!ec)
        {
            fray::log::engineInfo("Client connected!");
            auto session = std::make_shared<boost::asio::ip::tcp::socket>(std::move(sock));
            _sessions.insert(session);
            startRead(session);
        }
        if (_accepting && !_stopped)
            accept();
    });
}

inline F_void TCPServer::startRead(std::shared_ptr<boost::asio::ip::tcp::socket> session)
{
    auto header = std::make_shared<std::array<char,4>>();
    boost::asio::async_read(*session, boost::asio::buffer(*header),
        [this, session, header](boost::system::error_code ec, std::size_t){
            if (ec) {
                _sessions.erase(session);
                if (!_stopped && _sessions.empty()) stop();
                return;
            }

            uint32_t len;
            std::memcpy(&len, header->data(), 4);
            len = ntohl(len);
            auto body = std::make_shared<std::vector<char>>(len);
            boost::asio::async_read(*session, boost::asio::buffer(*body),
                [this, session, body](boost::system::error_code ec2, std::size_t){
                    if (ec2) {
                        _sessions.erase(session);
                        if (!_stopped && _sessions.empty()) stop();
                        return;
                    }
                    std::string msg(body->data(), body->size());
                    fray::log::engineInfo("Received from client: %s", msg.c_str());
                    uint32_t wlen = htonl((uint32_t)msg.size());
                    std::vector<char> out(4 + msg.size());
                    std::memcpy(out.data(), &wlen, 4);
                    std::memcpy(out.data()+4, msg.data(), msg.size());
                    boost::asio::async_write(*session, boost::asio::buffer(out),
                        [this, session](boost::system::error_code wec, std::size_t){
                            if (wec) {
                                _sessions.erase(session);
                                if (!_stopped && _sessions.empty()) stop();
                                return;
                            }
                            // Continue reading unless we were stopped.
                            if (!_stopped) startRead(session);
                        });
                });
        });
}

inline F_void TCPServer::stop()
{
    if (_stopped) return;
    _stopped = true;
    _accepting = false;

    boost::system::error_code ec;
    _acceptTimer.cancel();
    _acceptor.cancel(ec);
    if (_acceptor.is_open())
        _acceptor.close(ec);

    for (auto& s : _sessions)
    {
        if (!s) continue;
        boost::system::error_code sec;
        s->shutdown(boost::asio::ip::tcp::socket::shutdown_both, sec);
        s->close(sec);
    }
    _sessions.clear();

    fray::log::engineInfo("Stopped TCPServer on port %d.", _port);

    if (_manager)
        _manager->removeTCPServer(_port);
}

} // namespace ipc
} // namespace fray

#endif