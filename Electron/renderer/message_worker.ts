import { decodePrefix, parseFrame, PREFIX_SIZE } from './message';
import { routeMessage } from './message_router';

// Workers have no DOM window, so the DOM typing of `self` is narrowed to what this worker uses.
const worker = self as unknown as {
  onmessage: ((event: MessageEvent) => void) | null;
  postMessage(message: unknown, transfer?: Transferable[]): void;
  close(): void;
};

worker.onmessage = ({ data }) => {
  if (data.type === 'shutdown') {
    worker.postMessage({ type: 'stopped' });
    worker.close();
    return;
  }
  if (data.type !== 'frame') return;
  try {
    const frame = new Uint8Array(data.frame);
    const prefix = decodePrefix(frame);
    if (frame.length !== PREFIX_SIZE + prefix.length) throw new Error('Message length does not match its prefix.');
    if (routeMessage(prefix) !== 'electron-renderer') {
      throw new Error(`Cannot route message: unsupported destination kind=${prefix.destinationKind} id=${prefix.destinationId}.`);
    }
    const { header } = parseFrame(frame);
    worker.postMessage({ type: 'message', prefix, header, frame: data.frame }, [data.frame]);
  } catch (error) {
    worker.postMessage({ type: 'error', message: (error as Error).message });
  }
};

worker.postMessage({ type: 'ready' });
