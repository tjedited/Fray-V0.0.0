/* network_worker.js */
const { parentPort, workerData } = require('node:worker_threads');
const { TCPClient } = require('./ipc_manager');

const routerPort = workerData.routerPort;
const client = new TCPClient(workerData.host, workerData.port, 10000, 500, {
    onConnect: () => parentPort.postMessage({ type: 'connected' }),
    onFrame: (frame) => routerPort.postMessage({ type: 'frame', frame: frame.buffer }, [frame.buffer]),
    onError: (error) => parentPort.postMessage({ type: 'error', message: error }),
    onClose: () => {
        parentPort.postMessage({ type: 'closed' });
        routerPort.postMessage({ type: 'end' });
        routerPort.close();
        parentPort.close();
    },
});

routerPort.on('message', (event) => {
    if (event.type === 'invalid') client.client.destroy();
});

parentPort.on('message', (event) => {
    if (event.type === 'send' || event.type === 'shutdown') {
        if (event.frame) {
            if (client.connected) client.send(Buffer.from(event.frame));
            else parentPort.postMessage({ type: 'error', message: 'Cannot send: TCP client is not connected.' });
        }
        if (event.type === 'shutdown') client.close();
    }
});
