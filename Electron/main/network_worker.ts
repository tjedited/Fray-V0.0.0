/* network_worker.js */
import { parentPort, workerData, type MessagePort } from 'node:worker_threads';
import { TCPClient } from './ipc_manager';

const parent = parentPort!;
const routerPort: MessagePort = workerData.routerPort;
const client = new TCPClient(workerData.host, workerData.port, 10000, 500, {
    onConnect: () => {
        parent.postMessage({ type: 'connected' });
        routerPort.postMessage({ type: 'connected' });
    },
    onFrame: (frame: Buffer) => routerPort.postMessage({ type: 'frame', frame: frame.buffer }, [frame.buffer as ArrayBuffer]),
    onError: (error: string) => parent.postMessage({ type: 'error', message: error }),
    onClose: () => {
        parent.postMessage({ type: 'closed' });
        routerPort.postMessage({ type: 'end' });
        routerPort.close();
        parent.close();
    },
});

routerPort.on('message', (event: { type: string }) => {
    if (event.type === 'invalid') client.client.destroy();
});

parent.on('message', (event: { type: string; frame?: ArrayBuffer }) => {
    if (event.type === 'send' || event.type === 'shutdown') {
        if (event.frame) {
            if (client.connected) client.send(Buffer.from(event.frame));
            else parent.postMessage({ type: 'error', message: 'Cannot send: TCP client is not connected.' });
        }
        if (event.type === 'shutdown') client.close();
    }
});
