const assert = require('node:assert/strict');
const path = require('node:path');
const { test } = require('node:test');

const directory = process.env.FRAY_TEST_ELECTRON_MAIN
    ? path.dirname(process.env.FRAY_TEST_ELECTRON_MAIN)
    : path.join(__dirname, '../Electron/dist-electron');
const message = require(path.join(directory, 'message'));
const { createFrameBuilder } = require(path.join(directory, 'shared/frame_builder'));
const { createPromptClient } = require(path.join(directory, 'prompt_client'));

test('Main correlates prompt responses and rejects invalid choices', () => {
    const sent = [];
    const frames = createFrameBuilder(message.ProcessKind.PROCESS_KIND_ELECTRON_MAIN, 1, message.buildFrame, message.processName);
    const client = createPromptClient(frames, (frame) => sent.push(frame));
    const results = [];
    client.request({ title: 'Choose', buttons: [{ label: 'Yes', value: 'yes' }], dismissible: false },
        (result) => results.push(result));
    const request = message.parseFrame(sent[0]);
    assert.equal(request.prefix.commandId, message.Command.COMMAND_PROMPT_REQUEST);
    const response = (value, dismissed = false, senderKind = message.ProcessKind.PROCESS_KIND_ELECTRON_RENDERER) => {
        const payload = message.PromptResponse.encode(message.PromptResponse.fromObject({
            requestId: request.header.messageId, value, dismissed,
        })).finish();
        return message.parseFrame(message.buildFrame({
            destinationKind: message.ProcessKind.PROCESS_KIND_ELECTRON_MAIN, senderKind,
            commandId: message.Command.COMMAND_PROMPT_RESPONSE,
        }, { messageId: 7, payloadType: message.PayloadType.PAYLOAD_TYPE_PROTOBUF,
            messageType: message.MessageType.MESSAGE_TYPE_PROMPT_RESPONSE }, payload));
    };
    assert.throws(() => client.onMessage(response('bad')), /allowed choice/);
    assert.throws(() => client.onMessage(response('', true)), /allowed choice/);
    assert.throws(() => client.onMessage(response('yes', false, message.ProcessKind.PROCESS_KIND_ENGINE)), /sender/);
    assert.equal(client.onMessage(response('yes')), true);
    assert.deepEqual(results, [{ value: 'yes' }]);
    assert.throws(() => client.onMessage(response('yes')), /Unknown/);
    const makeResponse = (requestFrame, value, dismissed) => {
        const requestId = message.parseFrame(requestFrame).header.messageId;
        const payload = message.PromptResponse.encode(message.PromptResponse.fromObject({
            requestId, value, dismissed,
        })).finish();
        return message.parseFrame(message.buildFrame({
            destinationKind: message.ProcessKind.PROCESS_KIND_ELECTRON_MAIN,
            senderKind: message.ProcessKind.PROCESS_KIND_ELECTRON_RENDERER,
            commandId: message.Command.COMMAND_PROMPT_RESPONSE,
        }, { messageId: 8, payloadType: message.PayloadType.PAYLOAD_TYPE_PROTOBUF,
            messageType: message.MessageType.MESSAGE_TYPE_PROMPT_RESPONSE }, payload));
    };
    client.request({ title: 'First', buttons: [{ label: 'A', value: 'a' }] }, (result) => results.push(result));
    client.request({ title: 'Second', buttons: [{ label: 'B', value: 'b' }] }, (result) => results.push(result));
    client.onMessage(makeResponse(sent[2], 'b', false));
    client.onMessage(makeResponse(sent[1], '', true));
    assert.deepEqual(results.slice(1), [{ value: 'b' }, { value: null }]);
    client.request({ title: 'Pending', buttons: [{ label: 'OK', value: 'ok' }] }, (result) => results.push(result));
    client.cancel('Renderer is unavailable.');
    assert.deepEqual(results[3], { value: null, error: 'Renderer is unavailable.' });
});
