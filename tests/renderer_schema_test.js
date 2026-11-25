const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { promisify } = require('node:util');
const { execFile, spawnSync } = require('node:child_process');
const { test } = require('node:test');
const { pathToFileURL } = require('node:url');
const protobuf = require('../Electron/node_modules/protobufjs');

const execFileAsync = promisify(execFile);
const repo = path.resolve(__dirname, '..');
const electronDir = path.join(repo, 'Electron');
const schema = path.join(repo, 'Schemas', 'fray.proto');
const electron = require('../Electron/node_modules/electron');
const runner = path.join(electronDir, 'tests', 'schema_probe_runner.cjs');

async function probe(url, input) {
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    const { stdout } = await execFileAsync(electron, [runner, `${url}?header=${input.toString('hex')}`], {
        env, timeout: 20000,
    });
    const match = stdout.match(/SCHEMA_PROBE:(.*)/);
    assert.ok(match, `Missing renderer result: ${stdout}`);
    const result = JSON.parse(match[1]);
    assert.equal(result.error, undefined);
    return result;
}

test('renderer schema is regenerated and interoperates in development and production', { timeout: 120000 }, async () => {
    const vite = await import(pathToFileURL(require.resolve('../Electron/node_modules/vite')).href);
    const temp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'fray-renderer-schema-')));
    const root = path.join(temp, 'Electron');
    const tempSchema = path.join(temp, 'Schemas', 'fray.proto');
    const outDir = path.join(temp, 'dist');
    const configFile = path.join(root, 'vite.config.js');
    let server;
    let preview;
    try {
        await fs.mkdir(path.dirname(tempSchema), { recursive: true });
        await fs.mkdir(root, { recursive: true });
        for (const file of ['vite.config.js', 'package.json', 'renderer/message_schema.js',
            'tests/schema_probe.html', 'tests/schema_probe.js', 'tests/schema_probe_worker.js']) {
            const target = path.join(root, file);
            await fs.mkdir(path.dirname(target), { recursive: true });
            await fs.copyFile(path.join(electronDir, file), target);
        }
        await fs.symlink(path.join(electronDir, 'node_modules'), path.join(root, 'node_modules'), 'junction');
        const source = await fs.readFile(schema, 'utf8');
        await fs.writeFile(tempSchema, source);

        const Header = protobuf.loadSync(schema).lookupType('fray.Header');
        const input = Buffer.from(Header.encode(Header.fromObject({
            protocolVersion: 1,
            messageId: '18446744073709551615',
            timestamp: '18446744073709551614',
            senderName: 'Engine',
            destinationName: 'Renderer',
            targetProject: 'Project',
            payloadType: 2,
        })).finish());
        const expected = Header.toObject(Header.decode(input), { defaults: true, longs: String });

        async function verify(url, expectedProbe) {
            const result = await probe(url, input);
            assert.deepEqual(result.decoded, expected);
            assert.equal(result.nodeAvailable, false);
            assert.equal(result.malformedRejected, true);
            assert.equal(result.processKind, 4);
            assert.equal(result.payloadType, 2);
            assert.equal(result.messageType, 0);
            assert.equal(result.command, 1);
            assert.equal(result.buildProbe, expectedProbe);
            assert.deepEqual(result.worker, {
                messageId: '18446744073709551615',
                buildProbe: expectedProbe,
            });
            const output = Buffer.from(result.encoded, 'hex');
            const parsed = Header.toObject(Header.decode(output), { defaults: true, longs: String });
            assert.equal(parsed.messageId, '18446744073709551615');
            assert.equal(parsed.timestamp, '18446744073709551614');
            assert.equal(parsed.senderName, 'Renderer');
            assert.equal(parsed.targetProject, 'Project');
            const decoded = spawnSync('protoc', [`--proto_path=${path.dirname(schema)}`, '--decode=fray.Header', schema], {
                input: output, encoding: 'utf8',
            });
            assert.equal(decoded.status, 0, decoded.stderr);
            assert.match(decoded.stdout, /message_id: 18446744073709551615/);
            assert.match(decoded.stdout, /sender_name: "Renderer"/);
        }

        server = await vite.createServer({
            configFile, root, logLevel: 'silent', server: { host: '127.0.0.1', port: 0 },
        });
        await server.listen();
        const devUrl = `http://127.0.0.1:${server.httpServer.address().port}/tests/schema_probe.html`;
        const transformed = await fetch(new URL('/renderer/message_schema.js', devUrl)).then((response) => response.text());
        assert.match(transformed, /\/@id\/__x00__virtual:fray-schema/,
            `root=${server.config.root} plugins=${server.config.plugins.map((p) => p.name).join(',')} source=${transformed}`);
        await verify(devUrl, null);

        async function buildAndVerify(expectedProbe) {
            await vite.build({
                configFile, root, logLevel: 'silent',
                build: { outDir, emptyOutDir: true, rollupOptions: { input: path.join(root, 'tests', 'schema_probe.html') } },
            });
            preview = await vite.preview({
                configFile, root, logLevel: 'silent', build: { outDir },
                preview: { host: '127.0.0.1', port: 0 },
            });
            await verify(`http://127.0.0.1:${preview.httpServer.address().port}/tests/schema_probe.html`, expectedProbe);
            await new Promise((resolve, reject) => preview.httpServer.close((err) => err ? reject(err) : resolve()));
            preview = null;
        }
        await buildAndVerify(null);

        const change = new Promise((resolve) => server.watcher.on('change', (file) => {
            if (file === tempSchema) resolve();
        }));
        assert.ok(source.includes('  COMMAND_QUIT = 2;'), 'Test requires the current quit command.');
        await fs.writeFile(tempSchema, source.replace('  COMMAND_QUIT = 2;', '  COMMAND_QUIT = 2;\n  COMMAND_BUILD_PROBE = 99;'));
        await change;
        let updated = false;
        for (let attempt = 0; attempt < 100 && !updated; attempt++) {
            const generated = await fetch(new URL('/@id/__x00__virtual:fray-schema', devUrl)).then((response) => response.text());
            updated = generated.includes('COMMAND_BUILD_PROBE');
            if (!updated) await new Promise((resolve) => setTimeout(resolve, 20));
        }
        assert.ok(updated, 'Development schema did not reload after the change.');
        await verify(devUrl, 99);
        await buildAndVerify(99);

        await fs.writeFile(tempSchema, 'syntax = "proto3"; invalid');
        await assert.rejects(vite.build({
            configFile, root, logLevel: 'silent',
            build: { outDir, emptyOutDir: true, rollupOptions: { input: path.join(root, 'tests', 'schema_probe.html') } },
        }));
    } finally {
        if (preview) await new Promise((resolve) => preview.httpServer.close(resolve));
        if (server) await server.close();
        await fs.rm(temp, { recursive: true, force: true });
    }
});
