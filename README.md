# Fray V0.0.0
A New Platform for Creatives & Developers

## Engine C++ formatting

Put each function parameter on its own line after the opening parenthesis.

## Engine and Electron messaging

The Engine launches Electron. Each process uses its own built-in message router; Main does not register one. The
Engine router delivers application messages directly to its FrayManager. Electron
process-specific code lives in `Electron/main/` and `Electron/renderer/`.
Main owns a thread manager and separate network and message workers. Its message
worker reads the prefix and forwards renderer-bound frames without decoding the
header. Renderer-originated frames can be routed to Main or forwarded to the
Engine. The narrow preload bridge carries frames across Electron IPC; the
renderer has its own thread manager, message worker and router, and decodes
headers for local messages. Main and renderer application message handling live
in their respective `message_handler.ts` files. React plug-in dispatch is not
yet implemented. Renderer console messages are forwarded to the terminal by Main.

### Building frames

The Engine's `message::FrameBuilder` and Electron's `createFrameBuilder` accept
the same frame options: destination, command, optional destination ID, payload,
payload type, message type, target project and queue TTL. A nonempty payload
requires an explicit payload type. The builders fill in sender identity,
protocol version, message ID, timestamp and process names; `send` still accepts
the resulting frame separately. The Engine builder returns an `F_err` and
writes the frame to an output parameter; Electron's builder throws on invalid
input.

Electron Main and the renderer assign odd message IDs to their main/UI threads
and even IDs to their workers. Builders in the same thread share their ID
sequence. The Engine uses its process-wide atomic counter.

### Prompts and New Project

Engine, Electron Main, and renderer code can request a user prompt asynchronously.
Requests carry a title, optional description, buttons, and an optional dismissible
flag (default true). Responses are correlated to the request ID and report a
choice, dismissal, or error. Engine callbacks run on its application thread.
Use `FrayManager::requestPrompt` in the Engine, `requestPrompt` in Electron Main,
or `usePromptMessages` in renderer components. Prompts are non-modal, draggable,
and shown one at a time.

File > New Project opens a native save dialog to choose a project name and
location; the Engine creates a working folder there, not a file at the selected
path. If a folder or `.fry` archive exists, the prompt offers to open it or
choose another name. Choosing another name reopens the picker in the same folder.
If both exist, choose which to open; the other is renamed.
The Engine rechecks conflicts, validates existing databases, and reports success
or failure through notifications. Native save-dialog behavior varies by OS and
may include its own overwrite confirmation. An already-open project with the
same name cannot currently be opened from another directory.

File > Open Project selects a `.fry` archive or working folder. On platforms
that cannot select files and folders in one dialog, choose which kind first.
If both the archive and folder exist, choose which to open; the other is renamed.
If a selected folder has no valid Fray database, the prompt offers to create a
project in that folder. Existing files are preserved, and creation fails rather
than overwriting an occupied database path. Opening an archive extracts it into
a working folder and removes the archive after a successful open; the packaging
preference controls what happens when the project later closes.

File > Close Project closes the most recently opened project, honoring its
`project.preferences.packageOnClose` preference. File > Package Project closes
and packages that project regardless of the preference, without changing it.
After a project closes, the previous successfully opened project becomes active.
Both actions report their result through a notification.

The renderer's older asynchronous project-open request still opens or creates a
project in the Engine's working directory. With `compile-run-all.sh`, that is
`Engine/`. The `project.preferences.packageOnClose` setting controls packaging
when a project closes.

Router queues can discard messages when a neighbor goes down or is unreachable;
there is not yet a delivery acknowledgement or timeout for every request.
Pending requests therefore cannot all be guaranteed a response after a
disconnect or queue discard.

### Readiness

No process assumes a startup order. A process is ready for another to send to it
only after it has said so with `COMMAND_READY`, and a process that starts late
can ask with `COMMAND_REQUEST_READY`. Both are sent to the broadcast destination
(`PROCESS_KIND_BROADCAST`, every process except the sender) or to one process.

- Requests are sent at startup and once per second while probing a neighbor.
- A request is answered with a `READY` sent only to the requester, never
  broadcast.
- A `READY` from a neighbor that was not marked ready is answered with a
  `READY` sent only to that neighbor, so a process that starts late does not
  have to ask. Only that change triggers an answer, so the exchange ends after
  one `READY` each way.
- The router thread in each process owns the table of which neighbors are ready
  (the Engine's message thread, and the message workers in Main and the
  renderer). Nothing else reads it. Other threads learn of a change through a
  message, such as the renderer's UI thread hearing that Main is ready.
- Sending is one call, `send()`, which hands the message to the router and
  returns at once. The router sends it now if its destination is ready and
  otherwise keeps it in that destination's outgoing queue, in order, until the
  destination says it is ready. Nothing is reported back to the sender. Readiness
  messages and broadcasts are never held, because they are how readiness is
  learned and who can be reached is not known.
- Each message says how long it may wait, in `Header.ttl_ms`: 0 means until the
  destination is ready, anything else is a number of milliseconds counted from
  when a router queues it (so each router on the path restarts the count). The
  sender sets it when building the frame. Expired messages are dropped when the
  queue is flushed, the router next queues something, or its timer ticks.
- Queues have no size limit yet. A queue is discarded with `discardQueue` when a
  monitored neighbor is declared down or unreachable. Messages wait again when
  a neighbor is suspect or merely stops being ready.
- Main is ready when it is connected to the Engine and announces itself then.
  The renderer's only route to the others is Main, so it announces itself when it
  hears that Main is ready. This is what makes either start order work.
- The Engine never relays. Main delivers a broadcast to itself, the renderer and
  the Engine, except to the sender.
- Not yet implemented: a "stopping" announcement, and clearing the Engine's
  table immediately when a connection drops. The Engine detects silence through
  its monitoring timer; Main clears its entries for the Engine and renderer on
  disconnect, navigation or shutdown.

Each router monitors its currently implemented immediate neighbors: Engine
monitors Main, Main monitors Engine and the renderer, and the renderer monitors
Main. Unavailable plug-ins are not probed. Every second, a router probes a
neighbor until it announces `READY` or the 10-second budget expires. A late
`READY` can still restore it. Once ready, routers exchange `PING` and `PONG`;
any received frame resets the local silence timer. Three seconds of silence
marks the neighbor suspect, and ten seconds marks it down. Ordinary messages
queue while a neighbor is suspect or down; control messages bypass the queue.
Further traffic restores a previously ready neighbor. Timers are local and do
not wait for a response.

Each PONG carries a protobuf health report with the processed-message count,
time since last progress, the main/UI-thread heartbeat, and outgoing queue
depths and oldest-message ages. Heartbeats are posted locally to the router
once per second. Routine PING/PONG and health report logs are suppressed;
readiness and health warnings remain visible.
Electron disables background throttling for the window to keep the renderer's
heartbeat running while minimized. This can increase background resource use
and causes the page visibility API to report the page as visible.

The router marks a neighbor `DEGRADED` when its health report or heartbeat has
not advanced for three seconds, or when it reports a nonempty queue whose
processed count has not advanced for three seconds. Ordinary messages wait
until the neighbor recovers. With the current transport, a blocked Main or
renderer UI thread can also prevent the router's report from getting out:
its neighbor sees silence and marks it `SUSPECT` or `DOWN` instead. These
checks do not restart processes. Per-plug-in heartbeats are not implemented
because the plug-in system does not yet exist; the orphan watchdog and
supervisor are also deferred.

Renderer thread state and readiness are reported to Main. Frames for the
renderer wait in Main's outgoing queue until it says it is ready. On a normal window
close or app quit, Main requests renderer shutdown and waits for its registered
workers to acknowledge shutdown before stopping its own IPC workers and sending
the Engine a framed quit. Web Workers have no join API: the renderer terminates
each worker after its shutdown acknowledgement. A failed worker, renderer crash
or forced window destruction is reported as an unclean shutdown. A worker that
does not acknowledge shutdown keeps the app waiting. Reload or navigation
currently destroys renderer workers without coordinating shutdown and is logged;
coordinated reload remains future work.

Frames contain a fixed 23-byte routing prefix, a protobuf header and opaque
payload bytes. Routing supports one renderer at destination ID 0; nonzero
renderer IDs and other unsupported destinations are logged and dropped.
Engine quit handling is in its router; Engine forwarding, plug-in routing,
multi-window mapping and deduplication are not yet implemented. The current transport broadcasts Engine sends to connected
clients. Renderer-to-Main routing currently requires the Engine IPC workers to
be running. Electron IPC and preload may copy frame data; this has not yet been
measured.
JavaScript exposes the protobuf header's `messageId` and `timestamp` as decimal
strings to preserve their full 64-bit values. The Engine currently listens on
all network interfaces, and frame sizes are not yet capped; restrict access to
trusted clients.

The renderer's `renderer/message_schema.ts` exports protobuf types and enums
generated from `Schemas/fray.proto` by Vite. Generation runs on each build and
the development server reloads when that schema changes. The static code works
with the renderer's content security policy without `unsafe-eval`.
The generated types can also be imported from renderer Web Workers:

```ts
import { Header, PayloadType } from './message_schema';

const bytes = Header.encode(Header.fromObject({
  messageId: '18446744073709551615',
  payloadType: PayloadType.PAYLOAD_TYPE_JSON,
})).finish();
const header = Header.toObject(Header.decode(bytes), { longs: String });
```

## Electron TypeScript and builds

The Engine and native plug-ins are C++. Everything under `Electron/` is
TypeScript: Electron Main, the preload script and their worker threads in
`Electron/main/`, the React renderer and its worker in `Electron/renderer/`,
and types shared by all of them in `Electron/shared/types.ts` (including the
`FrayBridge` interface behind `window.frayBridge`).

Vite compiles it back to JavaScript. `npm run build:main` writes Main, its
workers and the preload script to `Electron/dist-electron/` as CommonJS (one
file per module, plus a single self-contained `preload.js`, since the sandboxed
preload cannot load other files). `package.json` points `main` at
`dist-electron/main.js`. The renderer is served by `vite` in development and
built into `Electron/dist/` by `npm run build:renderer`; `npm run build` does
both. `npm run start` builds Main first, so rerun it after editing Main code.
`npm run typecheck` checks Main and the renderer with `tsc` (both use strict
mode; Vite itself only strips types and does not check them). The editor
discovers Main and renderer settings through their `tsconfig.json` files.

The application menu has File and Edit menus. New Project and Open Project are
enabled; the other project commands are disabled placeholders. Edit uses native Undo and Redo for text editing, not project
history. On macOS, the application menu retains Quit. The window starts
frameless and windowed, with a draggable dark title bar above a black renderer.
On macOS, the native window buttons remain visible. A fullscreen preference is
not yet implemented.

### Notifications

Notifications stack at the bottom right, with new arrivals pushing older
notifications up and up to five visible.
Dismissed notifications fade out. New arrivals wait while a notification is hovered;
other visible notifications continue timing out. The hovered notification's
progress bar is hidden until its timer restarts on mouse leave. Notifications
default to four seconds, can be manually dismissed, and can specify a different
timeout or `null` for no timeout. The copy button copies the title and optional
description as plain text; an error is shown if copying fails.
Notifications use an MUI icon for their type. To override it, pass a React
element as the `icon` option to `notify`, or pass `null` to hide the icon.
New Project uses notifications for its results. Process log routing is not yet implemented.

### Prompts

Prompts are non-modal and can be dragged from anywhere except their buttons.
Multiple requests are queued and shown
one at a time. A prompt has a title, optional description, and caller-supplied
buttons. The close button is enabled by default and can be disabled by the
caller; closing reports `null`, while a choice reports its supplied value.

Material UI uses Emotion's inline styles. The renderer's content security
policy permits inline styles but continues to restrict scripts to `'self'`.

The IPC tests load the compiled Main code, so run `npm run build:main` in
`Electron/` before them.

Run `node --test tests/renderer_schema_test.js` to check development and
production generation, renderer and worker compatibility, and schema updates.
Run `node --test tests/ipc_test.js tests/renderer_ipc_test.js` to exercise TCP,
Electron IPC and coordinated shutdown, including an end-to-end exchange with
the compiled Engine. The tests use `Engine/build/Darwin/engine` by default;
set `FRAY_TEST_ENGINE` to use another build. The renderer IPC test uses port
5173. Its Engine uses `--no-ui` to run without launching a separate UI.
Run `node --test tests/outgoing_router_test.js` for the outgoing queue logic, and
`g++ -std=c++17 -IEngine tests/outgoing_router_test.cpp -o /tmp/fray-router-test && /tmp/fray-router-test`
for its Engine counterpart.
Check Engine timestamp formatting with
`g++ -std=c++17 tests/log_manager_test.cpp -o /tmp/fray-log-test && /tmp/fray-log-test`.

## Project and state management

Each engine process has one `fray::FrayManager`, which can own multiple
projects. Open a `.fry` archive or a working folder:

```cpp
fray::FrayManager app("Fray");
ERR(app.openProject("TestProject.fry").get());

fray::ProjectManager& project = app.project("TestProject");
ERR(project.set("project.info.projectVersion.major", 0));
ERR(project.set("project.info.projectVersion.minor", 0));
ERR(project.set("project.info.projectVersion.bug", 0));

std::string name;
F_long major;
ERR(project.get("project.info.name", name));
ERR(project.get("project.info.projectVersion.major", major));
ERR(project.close());
```

`project.info.name` is initialized from the archive or folder name when absent.
Each project owns a file manager and one or more state managers. The default
state manager backs `project.set` and `project.get`; other tables can be
opened independently:

```cpp
ERR(project.openState("examplePlugin"));
fray::state::StateManager& plugin = project.state("examplePlugin");
ERR(plugin.set("examplePlugin.field", "example value"));
std::string value;
ERR(plugin.get("examplePlugin.field", value));
```

State managers share the project's file manager and database. Opening a
state manager creates its table if needed; setting a key creates or replaces
that entry. Dots are part of the key, not separate tables. `remove(key)` deletes
an entry, `renameTable(name)` renames the current table, and `removeTable()`
**deletes the current table and all its entries**. A later `set` recreates a
removed table. Reopen a renamed table using its new name.

Supported values are strings, signed 64-bit integers, finite doubles, booleans,
and `StateManager::Binary`. Getters return `STATE_NOT_FOUND` for missing entries,
`STATE_TYPE_MISMATCH` for the wrong type, and `STATE_VALUE_OUT_OF_RANGE` when a
numeric value cannot fit the requested type; their output remains unchanged on
error. Keys and table names must be nonempty and contain no null characters.
Every successful `set` logs the key and complete value at info level, including
binary values as hexadecimal. Text and keys use byte escapes for control and
non-ASCII bytes. Avoid storing secrets in state if logs may be accessible.

## Project files and recovery

`TestProject.fry` is a ZIP archive. Its working folder is `TestProject/`, and
its database is `TestProject/TestProject.sqlite`. If the archive exists and
the folder does not, opening extracts the archive. If neither exists, opening
creates the folder and database. Opening an existing folder uses its name for
the project and creates the database if it is missing. Other project files can
be accessed under the working folder through `project.fileManager().filePath`.

Every time a project with an existing database is opened, Fray first copies the
database to `TestProject/snapshots/TestProject-<yyyymmddhhmmss>.sqlite` (with
`-<#>` added if that name is taken). If the database is about to be adopted under
a new name, the snapshot keeps its old name, and it is taken before the rename.
A project with no database has nothing to snapshot and opens normally. After a
`.fry` has been extracted, the `.fry` is deleted, so only the working folder
exists while the project is open. Closing with packaging on recreates the `.fry`,
snapshots included. With `project.preferences.packageOnClose` off, the working
folder stays and no `.fry` is written.

State changes are written to the working SQLite database immediately. By default,
the working folder remains when the project closes. To create or update the ZIP
archive on close and remove the working folder after it is written successfully,
set the persistent boolean preference:

```cpp
ERR(project.set("project.preferences.packageOnClose", true));
```

Existing projects retain their saved preference. Set it to `false` to leave the
working folder, or use File > Package Project for a one-time packaged close.
When packaging is disabled, an existing
archive is left unchanged, so both copies may exist and require conflict
resolution the next time the project is opened.

Call `close()` explicitly
and check its result: if archiving fails, the working folder is retained and
closing can be retried. If cleanup fails, the archive is preserved and closing
can be retried to remove the remaining folder without rewriting the archive.
For safety, cleanup refuses filesystem roots, home directories, the current
working directory or its ancestors. Packaging also includes and removes a
project's `.git` directory with the rest of the working folder.
`app.closeProject(name)` closes and removes a project from the manager;
`app.close()` closes all projects. Destructors attempt to close remaining
projects, but cannot report errors to the caller. References to a project or
state manager must not be used after its owner is closed or removed.

If both the archive and matching folder exist, `openProject` (once its future resolves) returns
`PROJECT_CONFLICT` by default. Ask the user which copy to open, then retry with
`fray::files::ConflictChoice::Archive` or `ConflictChoice::Folder`. The archive
choice renames the working folder to an available name such as `TestProject-unselected-1/`
and extracts the archive into `TestProject/`. The folder choice renames the
archive to an available name such as `TestProject-unselected-1.fry` and opens the original
folder. Fray adjusts the database filename and SQLite sidecars if present in the
renamed folder or a readable ZIP; stored state values remain unchanged. An
unreadable ZIP is set aside unchanged. Neither existing folders nor archives are overwritten. The engine's
current startup prompts for this choice when opening `TestProject.fry`.

A `.lock` sidecar named after the project (such as `TestProject.lock`) prevents
simultaneous opens by cooperating Fray processes and is removed when its lock is
released. A crash or forced termination may leave a stale lock file;
it can be removed when no Fray process is using the project. Do not delete a
lock while a project is open. Stop older Fray processes before using this version:
older versions may use a different lock name or retain a lock-file handle across
cleanup. Old lock files are not removed automatically. Do not modify a project's
files externally while it is open, other than renaming the working folder or
database as described below. ZIP extraction rejects unsafe paths and
symbolic links, and archiving refuses symbolic links.

### Project names and renaming

The file name is the source of truth for the project name. When a project opens
and `project.info.name` differs from the `.fry` / working-folder name, `project.info.name`
is updated and the database is renamed to `<name>.sqlite`. If `<name>.sqlite`
is missing, Fray looks at the other `.sqlite` files in the folder. Only files
containing the current `fray_state_<hex>` table count as Fray databases; others
are ignored and left untouched.

- No candidate: a new database is created.
- One candidate: it is renamed to `<name>.sqlite`.
- Several candidates: `openProject` yields `DATABASE_CONFLICT` and the project
  waits. Call `app.databaseCandidates(name)`, then
  `app.resolveDatabase(name, DatabaseChoice::use(candidate))` or
  `DatabaseChoice::create()`, or `app.cancelProject(name)` (which removes a
  folder that was extracted only for the choice).

Setting `project.info.name` while a project is open
(`project.set("project.info.name", "NewName")`) immediately renames the working
folder, the database (and sidecars), the `.lock` file and, if present, the
existing `.fry` file, and keeps the project registered under its new name.
Names must be a single path component and may not end in `.fry`. If a target
already exists the rename fails and nothing changes.

### Watching files and threads

Each `ProjectManager` has a `watch::FileWatcher` (`file_watcher.hpp`) that
compares snapshots of the working folder once a second and reports `Added`,
`Removed`, `Renamed` (matched by inode / file index) and `Modified` changes.
Subscribers register a filter and a handler with `subscribe`. The polling
thread only queues events; `dispatch()` runs handlers on the thread that calls
it, which for a managed project is the project's own thread, under the project's
lock. `hold()` pauses polling while the owner changes files itself.

The first use is name tracking: renaming the working folder while Fray runs
updates the database file, lock and `project.info.name`; renaming the database
updates the folder, lock and `project.info.name`. If both are renamed, the folder
name wins. State databases are closed and reopened around each rename. Other
files in the folder can be edited freely. On macOS and Linux the OS allows
renaming open files, so renames are detected and followed; on Windows the OS
blocks renaming a folder that contains open files.

`ThreadManager` (`thread_manager.hpp`) is owned by `FrayManager`. Every project
gets its own thread and task queue: `openProject` returns a future so
several projects can load at once; call `.get()` to wait. A
project registers additional threads (such as its file watcher) with
`registerThread`, and its own thread stays alive until they have all ended.
`FrayManager`'s own methods are meant to be driven from one controlling thread;
`ProjectManager` and `StateManager` methods are internally synchronized.

Databases from previous state-storage iterations are not migrated. Old tables
are left untouched, but their values are not available through the current
state manager. Plug-in loading does not yet automatically create state objects.
Undo/redo and grouped transactions are not implemented.

## Tests

The engine requires SQLite and libzip (for example, Homebrew `sqlite` and
`libzip` on macOS, or the corresponding vcpkg packages on Windows). On macOS,
run the storage tests in a new temporary directory:

```sh
test_dir="$(mktemp -d)"
g++ -std=c++17 -IEngine -I/opt/homebrew/include tests/store_test.cpp tests/state_manager_link_test.cpp -L/opt/homebrew/lib -lsqlite3 -lzip -o "$test_dir/store-test"
"$test_dir/store-test" "$test_dir/state.fry" "$test_dir/legacy.fry"
g++ -std=c++17 -IEngine -I/opt/homebrew/include tests/file_manager_test.cpp -L/opt/homebrew/lib -lsqlite3 -lzip -o "$test_dir/file-manager-test"
"$test_dir/file-manager-test" "$test_dir"
g++ -std=c++17 -IEngine -I/opt/homebrew/include tests/rename_test.cpp -L/opt/homebrew/lib -lsqlite3 -lzip -pthread -o "$test_dir/rename-test"
mkdir "$test_dir/rename" && "$test_dir/rename-test" "$test_dir/rename"
g++ -std=c++17 -IEngine -IEngine/build/generated -I/opt/homebrew/include $(pkg-config --cflags protobuf) tests/application_dispatch_test.cpp tests/application_dispatch_link_test.cpp Engine/build/generated/fray.pb.cc -L/opt/homebrew/lib $(pkg-config --libs protobuf) -lsqlite3 -lzip -pthread -o "$test_dir/application-dispatch-test"
mkdir "$test_dir/dispatch" && "$test_dir/application-dispatch-test" "$test_dir/dispatch"
```

The application-dispatch test uses the protobuf files generated by the Engine build.
