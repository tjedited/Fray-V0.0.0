import { PREFIX_SIZE } from './message';
import { ThreadManager } from './thread_manager';

export class IPCManager {
  constructor(bridge, onMessage, onReady = () => {}) {
    this.bridge = bridge;
    this.ready = false;
    this.closing = false;
    this.threads = new ThreadManager((names) => bridge.reportState(
      this.closing ? 'stopping' : this.ready ? 'ready' : 'starting', names));
    let worker;
    try {
      worker = new Worker(new URL('./message_worker.js', import.meta.url), { type: 'module' });
    } catch (error) {
      bridge.reportState('failed', []);
      throw error;
    }
    this.worker = this.threads.spawn('renderer-messages', worker);
    this.worker.addEventListener('message', ({ data }) => {
      if (data.type === 'ready') {
        if (this.closing) return;
        this.ready = true;
        bridge.reportState('ready', this.threads.runningNames());
        onReady();
      } else if (data.type === 'message') {
        const frame = new Uint8Array(data.frame);
        onMessage({ prefix: data.prefix, header: data.header,
          payload: frame.subarray(PREFIX_SIZE + data.prefix.headerLength) });
      } else if (data.type === 'error') {
        console.error(`Message thread: ${data.message}`);
      }
    });
    this.worker.addEventListener('error', () => bridge.reportState('failed', this.threads.runningNames()));
    this.removeFrame = bridge.onFrame((frame) => {
      if (this.closing) {
        console.error('Cannot receive frame: renderer IPC is closing.');
        return;
      }
      const bytes = Uint8Array.from(frame);
      this.worker.postMessage({ type: 'frame', frame: bytes.buffer }, [bytes.buffer]);
    });
    this.removeShutdown = bridge.onShutdown(() => {
      this.close().catch((error) => {
        console.error(`Failed to stop renderer threads: ${error.message}`);
        bridge.reportState('failed', this.threads.runningNames());
      });
    });
  }

  send(frame) {
    if (this.closing) throw new Error('Cannot send: renderer IPC is closing.');
    this.bridge.sendFrame(frame);
  }

  async close() {
    if (this.closePromise) return this.closePromise;
    this.closing = true;
    this.closePromise = (async () => {
      await this.threads.stopAll();
      this.removeFrame();
      this.removeShutdown();
      this.bridge.reportState('stopped', this.threads.runningNames());
    })();
    return this.closePromise;
  }
}
