/* ipc_manager.hpp */

#ifndef _FRAY_IPC_MANAGER_HPP_
#define _FRAY_IPC_MANAGER_HPP_

#include <boost/asio.hpp>
#include <array>
#include <set>
#include <vector>
#include <algorithm>
#include <deque>
#include <condition_variable>
#include <functional>
#include <map>
#include <mutex>
#include <limits>
#include <string>
#include "errors.hpp"
#include "log_manager.hpp"
#include "message.hpp"
#include "message_router.hpp"
#include "neighbor_monitor.hpp"
#include "outgoing_router.hpp"
#include "thread_manager.hpp"
#include "types.hpp"

namespace fray
{
    namespace ipc
    {

        using Frame = std::shared_ptr<const std::vector<F_uchar>>;
        using Socket = std::shared_ptr<boost::asio::ip::tcp::socket>;
        using ConnectionHandler = std::function<void(Socket)>;

        class IPCManager; // forward

        class TCPServer : public std::enable_shared_from_this<TCPServer>
        {
        private:
            boost::asio::ip::tcp::acceptor _acceptor;
            F_bool _accepting = true;
            F_bool _stopped = false;
            F_ushort _port = 0;
            std::set<std::shared_ptr<boost::asio::ip::tcp::socket>> _sessions;
            IPCManager *_manager = nullptr;
            ConnectionHandler _connectionHandler = nullptr;
            // Frames waiting to be written, per session. Only the network thread touches these.
            std::map<std::shared_ptr<boost::asio::ip::tcp::socket>,
                     std::deque<Frame>> _outgoing;

            F_void accept();
            F_void startRead(std::shared_ptr<boost::asio::ip::tcp::socket> session);
            F_void write(Socket session, Frame frame);
            F_void writeNext(std::shared_ptr<boost::asio::ip::tcp::socket> session);
            F_void closeSession(Socket session);

        public:
            TCPServer(boost::asio::io_context &ctx, F_ushort port, IPCManager *manager)
                : _acceptor(ctx, {boost::asio::ip::tcp::v4(), port}),
                  _port(port),
                  _manager(manager)
            {
                // Port 0 asks the OS for a free port; read back the one it chose.
                _port = _acceptor.local_endpoint().port();
                fray::log::engineInfo("Constructed server on port %d.", _port);
            }

            ~TCPServer()
            {
                fray::log::engineInfo("Destroyed TCPServer on port %d.", _port);
            }

            F_void setConnectionHandler(ConnectionHandler handler) { _connectionHandler = std::move(handler); }
            F_void start() { accept(); }
            F_void stop();
            // Queues a message for every connected client. Network thread only; use IPCManager::send elsewhere.
            F_void broadcast(Frame frame);
            // Network thread only.
            F_void sendTo(Socket session, Frame frame)
            {
                if (!session || !frame)
                {
                    fray::log::engineError("Cannot send a message without a session and frame.");
                    return;
                }
                write(std::move(session), std::move(frame));
            }
            F_ushort port() const { return _port; }
        };

        using TCPServerSP = std::shared_ptr<TCPServer>;

        // Owns the TCP servers and the threads around them:
        //  - the network thread runs the io_context and is the only thread that touches sockets;
        //  - the engine message thread runs the message router, one message at a time, in arrival order.
        // Messages are one-way. Nothing is sent back unless the engine calls send().
        class IPCManager
        {
        private:
            boost::asio::io_context _io;
            boost::asio::steady_timer _monitorTimer{_io};
            std::vector<TCPServerSP> _servers;
            threads::TaskQueue _messages;
            bool _started = false;
            threads::ThreadManager::Id _networkThread = 0;
            threads::ThreadManager::Id _messageThread = 0;
            std::mutex _networkMutex;
            std::condition_variable _networkWake;
            bool _networkStopped = false;
            uint64_t _heartbeat = 0;
            uint64_t _processedCount = 0;
            std::chrono::steady_clock::time_point _lastProgress = std::chrono::steady_clock::now();
            // Owned by the engine message thread, which is the router: nothing else may touch it.
            routing::OutgoingRouter<ProcessKind, Frame> _outgoing{
                [this](ProcessKind, const Frame &frame) { transmit(frame); }};
            routing::NeighborMonitor<ProcessKind> _monitor{
                [this](ProcessKind neighbor, routing::MonitorCommand command)
                {
                    const auto id = command == routing::MonitorCommand::probe ? COMMAND_REQUEST_READY : COMMAND_PING;
                    if (command == routing::MonitorCommand::probe)
                        fray::log::engineInfo("Sending readiness probe to %s.", message::processName(neighbor));
                    send(message::makeEngineFrame(neighbor, 0, id));
                },
                [this](ProcessKind neighbor) { return _outgoing.state(neighbor); },
                [this](ProcessKind neighbor, routing::NeighborState state)
                {
                    if (state == routing::NeighborState::ready)
                    {
                        const auto previous = _outgoing.state(neighbor);
                        if (_outgoing.markReady(neighbor) &&
                            (previous == routing::NeighborState::suspect || previous == routing::NeighborState::degraded ||
                             previous == routing::NeighborState::down))
                            fray::log::engineInfo("%s recovered and is ready.", message::processName(neighbor));
                    }
                    else
                    {
                        _outgoing.setState(neighbor, state);
                        if (state == routing::NeighborState::down || state == routing::NeighborState::unreachable)
                            _outgoing.discardQueue(neighbor);
                        if (state == routing::NeighborState::probing) return;
                        const char *name = state == routing::NeighborState::suspect ? "SUSPECT" :
                            state == routing::NeighborState::degraded ? "DEGRADED" :
                            state == routing::NeighborState::down ? "DOWN" : "UNREACHABLE";
                        fray::log::engineWarn("%s is %s.", message::processName(neighbor), name);
                    }
                }};
            // Declared last so any threads it owns are joined before anything they use is destroyed.
            std::unique_ptr<threads::ThreadManager> _ownedThreads;
            threads::ThreadManager *_threads;

        public:
            // Uses its own ThreadManager, which is convenient for tests.
            IPCManager()
                : _ownedThreads(std::make_unique<threads::ThreadManager>()), _threads(_ownedThreads.get())
            {
                fray::log::engineInfo("Constructed IPCManager.");
            }

            // Registers its threads with a ThreadManager owned by someone else, which must outlive this object.
            explicit IPCManager(threads::ThreadManager &threads) : _threads(&threads)
            {
                fray::log::engineInfo("Constructed IPCManager.");
            }

            ~IPCManager()
            {
                if (_started)
                {
                    stop();
                    wait();
                }
                else
                {
                    const auto servers = _servers;
                    for (const auto &s : servers)
                        if (s)
                            s->stop();
                }
                _servers.clear();
                fray::log::engineInfo("Destroyed IPCManager.");
            }

            // Servers must be created before start().
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
                                       [port](const TCPServerSP &sp)
                                       { return sp && sp->port() == port; });
                if (it != _servers.end())
                    _servers.erase(it);
                // Stop io_context when no servers remain.
                if (_servers.empty())
                {
                    fray::log::engineInfo("No servers remaining; stopping io_context.");
                    _monitorTimer.cancel();
                    _io.stop();
                }
            }

            // Starts the network thread and the engine message thread, then returns.
            F_void start()
            {
                if (_started)
                    return;
                _started = true;
                _messageThread = _threads->spawn("engine-messages", [this](threads::StopToken)
                                                { _messages.run(); });
                _messages.post([this] { _monitor.start(PROCESS_KIND_ELECTRON_MAIN); });
                scheduleMonitor();
                _networkThread = _threads->spawn("network", [this](threads::StopToken)
                {
                    try { _io.run(); }
                    catch (...) { networkFinished(); throw; }
                    networkFinished();
                });
            }

            F_void networkFinished()
            {
                {
                    std::lock_guard<std::mutex> lock(_networkMutex);
                    _networkStopped = true;
                }
                _networkWake.notify_all();
            }

            F_void scheduleMonitor()
            {
                _monitorTimer.expires_after(std::chrono::seconds(1));
                _monitorTimer.async_wait([this](const boost::system::error_code &error)
                {
                    if (error == boost::asio::error::operation_aborted) return;
                    if (error)
                    {
                        fray::log::engineError("Monitor timer failed: %s", error.message().c_str());
                        return;
                    }
                    _messages.post([this] { _outgoing.sweep(); _monitor.tick(); });
                    scheduleMonitor();
                });
            }

            // Blocks until every server has stopped and the queued messages have been handled.
            F_void wait()
            {
                {
                    std::unique_lock<std::mutex> lock(_networkMutex);
                    while (!_networkStopped)
                    {
                        _messages.post([this] { ++_heartbeat; });
                        _networkWake.wait_for(lock, std::chrono::seconds(1), [this] { return _networkStopped; });
                    }
                }
                _threads->join(_networkThread);
                _messages.shutdown();
                _threads->join(_messageThread);
            }

            // Asks every server to stop. Safe from any thread; wait() returns once the last one is gone.
            F_void stop()
            {
                boost::asio::post(_io, [this]()
                                  {
                    const auto servers = _servers;
                    for (const auto &s : servers)
                        if (s)
                            s->stop(); });
            }

            // Hands a message to the router and returns at once. Safe from any thread.
            // The router delivers it now if its destination is ready, otherwise it waits in that destination's queue
            // for as long as the header's ttl_ms allows (0 = until the destination is ready).
            // Nothing is sent back to the caller either way.
            F_void send(Frame frame)
            {
                if (!frame)
                {
                    fray::log::engineError("Cannot send an empty frame pointer.");
                    return;
                }
                if (!_messages.post([this, frame = std::move(frame)]() { route(frame); }))
                    fray::log::engineError("Cannot send message: message thread is shutting down.");
            }

            // Router thread only. Readiness messages and broadcasts always go out at once, because they are how
            // readiness is learned and who is reachable is not known yet. Everything else goes through the outgoing queue.
            F_void route(const Frame &frame)
            {
                message::InData outgoing;
                const F_err err = message::parseFrame(frame, outgoing);
                if (err != fray::errors::NONE)
                {
                    fray::log::engineError("Cannot send message: %s", fray::errors::description(err));
                    return;
                }
                const auto &prefix = outgoing.prefix;
                if (prefix.commandId != COMMAND_READY && prefix.commandId != COMMAND_REQUEST_READY &&
                    prefix.commandId != COMMAND_PING && prefix.commandId != COMMAND_PONG)
                {
                    ++_processedCount;
                    _lastProgress = std::chrono::steady_clock::now();
                }
                if (prefix.destinationKind == PROCESS_KIND_BROADCAST || prefix.commandId == COMMAND_READY ||
                    prefix.commandId == COMMAND_REQUEST_READY || prefix.commandId == COMMAND_PING ||
                    prefix.commandId == COMMAND_PONG)
                    transmit(frame);
                else if (!_outgoing.send(prefix.destinationKind, frame, outgoing.header.ttl_ms()))
                    fray::log::engineInfo("%s is not ready; the message is waiting.", message::processName(prefix.destinationKind));
            }

            // Writes a frame to every connected client. Safe from any thread.
            F_void transmit(Frame frame)
            {
                boost::asio::post(_io, [this, frame = std::move(frame)]()
                                  {
                    for (const auto &s : _servers)
                        if (s)
                            s->broadcast(frame); });
            }

            // A READY marks the sender ready and delivers whatever was waiting for it. A REQUEST_READY is answered with
            // a READY sent back to the sender only, so no peer ever has to announce to everyone because someone else asked.
            F_void handleReadiness(const message::InData &incoming)
            {
                const auto &prefix = incoming.prefix;
                if (prefix.senderKind == PROCESS_KIND_ENGINE || prefix.senderKind == PROCESS_KIND_BROADCAST)
                    return;
                if (prefix.commandId == COMMAND_READY)
                {
                    const bool wasReady = _outgoing.isReady(prefix.senderKind);
                    _monitor.observe(prefix.senderKind, true);
                    // Answer a newly ready neighbor with our own READY so it need not ask. Only a change triggers it, so
                    // the exchange ends after one reply each way.
                    if (_outgoing.state(prefix.senderKind) != routing::NeighborState::degraded)
                        _outgoing.markReady(prefix.senderKind);
                    if (!wasReady && _outgoing.isReady(prefix.senderKind))
                    {
                        fray::log::engineInfo("%s is ready.", message::processName(prefix.senderKind));
                        send(message::makeEngineFrame(prefix.senderKind, prefix.senderId, COMMAND_READY));
                    }
                }
                else if (prefix.commandId == COMMAND_REQUEST_READY)
                {
                    send(message::makeEngineFrame(prefix.senderKind, prefix.senderId, COMMAND_READY));
                }
                else if (prefix.commandId == COMMAND_PING)
                {
                    HealthReport report;
                    report.set_processed_count(_processedCount);
                    report.set_heartbeat(_heartbeat);
                    report.set_progress_age_ms(std::chrono::duration_cast<std::chrono::milliseconds>(
                        std::chrono::steady_clock::now() - _lastProgress).count());
                    for (const auto &queue : _outgoing.queueHealth())
                    {
                        auto *item = report.add_queues();
                        item->set_destination(queue.destination);
                        item->set_depth(queue.depth);
                        item->set_oldest_age_ms(queue.oldestAgeMs);
                    }
                    fray::log::engineInfo("Sending health report to %s: heartbeat=%llu processed=%llu queues=%d.",
                        message::processName(prefix.senderKind), static_cast<unsigned long long>(_heartbeat),
                        static_cast<unsigned long long>(_processedCount), report.queues_size());
                    send(message::makeEngineFrame(prefix.senderKind, prefix.senderId, COMMAND_PONG,
                        PAYLOAD_TYPE_PROTOBUF, report.SerializeAsString(), 0, MESSAGE_TYPE_HEALTH_REPORT));
                }
                else if (prefix.commandId == COMMAND_PONG)
                {
                    HealthReport report;
                    if (incoming.header.payload_type() != PAYLOAD_TYPE_PROTOBUF ||
                        incoming.header.message_type() != MESSAGE_TYPE_HEALTH_REPORT ||
                        !report.ParseFromArray(incoming.payload(), static_cast<int>(incoming.payloadSize())))
                    {
                        fray::log::engineError("Invalid health report from %s.", message::processName(prefix.senderKind));
                    }
                    else
                    {
                        routing::NeighborMonitor<ProcessKind>::HealthReport health{
                            report.processed_count(), report.progress_age_ms(), report.heartbeat(), {}};
                        for (const auto &queue : report.queues())
                            health.queues.push_back({queue.destination(), queue.depth(), queue.oldest_age_ms()});
                        fray::log::engineInfo("Health report from %s: heartbeat=%llu processed=%llu progress_age_ms=%llu queues=%d.",
                            message::processName(prefix.senderKind), static_cast<unsigned long long>(report.heartbeat()),
                            static_cast<unsigned long long>(report.processed_count()),
                            static_cast<unsigned long long>(report.progress_age_ms()), report.queues_size());
                        for (const auto &queue : report.queues())
                            fray::log::engineInfo("Health queue %s: depth=%llu oldest_age_ms=%llu.",
                                message::processName(queue.destination()), static_cast<unsigned long long>(queue.depth()),
                                static_cast<unsigned long long>(queue.oldest_age_ms()));
                        _monitor.report(prefix.senderKind, std::move(health));
                    }
                }
                if (prefix.commandId != COMMAND_READY)
                    _monitor.observe(prefix.senderKind, false);
            }

            // Called by the network thread: queues a received message for the engine message thread.
            F_void queueMessage(Frame frame)
            {
                if (!_messages.post([this, frame = std::move(frame)]()
                               {
                    message::Prefix prefix;
                    F_err err = message::decodePrefix(frame->data(), frame->size(), prefix);
                    if (err != fray::errors::NONE)
                    {
                        fray::log::engineError("Message processing failed: %s", fray::errors::description(err));
                        return;
                    }
                    if (routing::routeMessage(prefix) != routing::Destination::engine)
                        return;
                    message::InData incoming;
                    err = message::parseFrame(frame, incoming);
                    if (err != fray::errors::NONE)
                        fray::log::engineError("Message processing failed: %s", fray::errors::description(err));
                    else
                    {
                        if (prefix.commandId != COMMAND_READY && prefix.commandId != COMMAND_REQUEST_READY &&
                            prefix.commandId != COMMAND_PING && prefix.commandId != COMMAND_PONG)
                        {
                            ++_processedCount;
                            _lastProgress = std::chrono::steady_clock::now();
                        }
                        if (routing::handleEngineMessage(incoming) == routing::Action::stop) stop();
                        else handleReadiness(incoming);
                    } }))
                    fray::log::engineError("Cannot queue message: message thread is shutting down.");
            }
        };

        /* ---- TCPServer method definitions ---- */

        inline F_void TCPServer::accept()
        {
            if (!_accepting || _stopped)
                return;
            auto self = shared_from_this();

            _acceptor.async_accept(
                [this, self](
                    boost::system::error_code ec,
                    boost::asio::ip::tcp::socket sock)
                {
        if (_stopped) return;
        if (!ec)
        {
            fray::log::engineInfo("Client connected.");
            auto session = std::make_shared<boost::asio::ip::tcp::socket>(std::move(sock));
            _sessions.insert(session);
            if (_connectionHandler)
                _connectionHandler(session);
            startRead(session);
        }
        if (_accepting && !_stopped)
            accept(); });
        }

        inline F_void TCPServer::startRead(
            std::shared_ptr<boost::asio::ip::tcp::socket> session)
        {
            auto self = shared_from_this();
            auto prefixBytes = std::make_shared<std::array<F_uchar, message::PREFIX_SIZE>>();
            boost::asio::async_read(
                *session,
                boost::asio::buffer(*prefixBytes),
                [this, self, session, prefixBytes](
                    boost::system::error_code ec,
                    std::size_t bytesRead)
                {
                    if (ec)
                    {
                        if ((ec != boost::asio::error::eof || bytesRead != 0) && ec != boost::asio::error::operation_aborted)
                            fray::log::engineError("Failed to read message prefix: %s", ec.message().c_str());
                        closeSession(session);
                        return;
                    }

                    message::Prefix prefix;
                    const F_err err = message::decodePrefix(prefixBytes->data(), prefixBytes->size(), prefix);
                    if (err != errors::NONE)
                    {
                        fray::log::engineError("Invalid message prefix: %s", errors::description(err));
                        closeSession(session);
                        return;
                    }
                    if (prefix.headerLength > static_cast<F_ulong>(std::numeric_limits<int>::max()))
                    {
                        fray::log::engineError("Message header exceeds the protobuf size limit.");
                        closeSession(session);
                        return;
                    }
                    auto frame = std::make_shared<std::vector<F_uchar>>(message::PREFIX_SIZE + static_cast<size_t>(prefix.length));
                    std::copy(prefixBytes->begin(), prefixBytes->end(), frame->begin());

                    boost::asio::async_read(
                        *session, boost::asio::buffer(frame->data() + message::PREFIX_SIZE, prefix.length),
                        [this, self, session, frame](
                            boost::system::error_code ec2,
                            std::size_t)
                        {
                            if (ec2)
                            {
                                if (ec2 != boost::asio::error::operation_aborted)
                                    fray::log::engineError("Failed to read message body: %s", ec2.message().c_str());
                                closeSession(session);
                                return;
                            }

                            if (_manager)
                                _manager->queueMessage(std::move(frame));
                            if (!_stopped)
                                startRead(session);
                        });
                });
        }

        inline F_void TCPServer::broadcast(Frame frame)
        {
            if (_stopped)
                return;
            const auto sessions = _sessions;
            for (const auto &session : sessions)
                write(session, frame);
        }

        inline F_void TCPServer::write(
            std::shared_ptr<boost::asio::ip::tcp::socket> session,
            Frame frame)
        {
            auto &queue = _outgoing[session];
            queue.push_back(std::move(frame));
            // Only one write may be in flight per socket.
            if (queue.size() == 1)
                writeNext(session);
        }

        inline F_void TCPServer::writeNext(std::shared_ptr<boost::asio::ip::tcp::socket> session)
        {
            const auto found = _outgoing.find(session);
            if (found == _outgoing.end() || found->second.empty())
                return;
            auto frame = found->second.front();
            auto self = shared_from_this();
            boost::asio::async_write(
                *session,
                boost::asio::buffer(*frame),
                [this, self, session, frame](boost::system::error_code ec, std::size_t)
                {
                    if (ec)
                    {
                        if (ec != boost::asio::error::operation_aborted)
                            fray::log::engineError("Failed to write message: %s", ec.message().c_str());
                        closeSession(session);
                        return;
                    }
                    const auto pending = _outgoing.find(session);
                    if (pending == _outgoing.end())
                        return;
                    pending->second.pop_front();
                    if (!_stopped)
                        writeNext(session);
                });
        }

        inline F_void TCPServer::closeSession(Socket session)
        {
            boost::system::error_code ec;
            session->close(ec);
            _sessions.erase(session);
            _outgoing.erase(session);
        }

        inline F_void TCPServer::stop()
        {
            if (_stopped)
                return;
            _stopped = true;
            _accepting = false;

            boost::system::error_code ec;
            _acceptor.cancel(ec);
            if (_acceptor.is_open())
                _acceptor.close(ec);

            for (auto &s : _sessions)
            {
                if (!s)
                    continue;
                boost::system::error_code sec;
                s->shutdown(boost::asio::ip::tcp::socket::shutdown_both, sec);
                s->close(sec);
            }
            _sessions.clear();
            _outgoing.clear();

            fray::log::engineInfo("Stopped TCPServer on port %d.", _port);

            if (_manager)
                _manager->removeTCPServer(_port);
        }

    } // namespace ipc
} // namespace fray

#endif