import { decodePrefix, parseFrame, PREFIX_SIZE } from './message';
import { routeMessage } from './message_router';

self.onmessage = ({ data }) => {
  if (data.type === 'shutdown') {
    self.postMessage({ type: 'stopped' });
    self.close();
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
    self.postMessage({ type: 'message', prefix, header, frame: data.frame }, [data.frame]);
  } catch (error) {
    self.postMessage({ type: 'error', message: error.message });
  }
};

self.postMessage({ type: 'ready' });
