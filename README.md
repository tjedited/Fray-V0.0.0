# Fray V0.0.0
A New Platform for Creatives & Developers

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
the ZIP archive is created or updated when the project closes and, after it is
written successfully, the working folder is removed. To leave the working
folder instead, set the persistent boolean preference:

```cpp
ERR(project.set("project.preferences.packageOnClose", false));
```

Set it to `true` to package again. When packaging is disabled, an existing
archive is left unchanged, so both copies may exist and require conflict
resolution the next time the project is opened. The example engine startup
explicitly sets the preference to `true` on every run.

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
```
