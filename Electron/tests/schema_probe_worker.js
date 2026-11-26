import { Header, Command } from '../renderer/message_schema';

const encoded = Header.encode(Header.fromObject({ messageId: '18446744073709551615' })).finish();
const decoded = Header.toObject(Header.decode(encoded), { longs: String });
self.postMessage({ messageId: decoded.messageId, buildProbe: Command.COMMAND_BUILD_PROBE ?? null });
