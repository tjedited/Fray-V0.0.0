# Fray V0.0.0
A New Platform for Creatives & Developers

## Project and state management

Each engine process has one `fray::FrayManager`, which can own multiple
projects. Open a `.fry` archive or a working folder:

```cpp
fray::FrayManager app("Fray");
ERR(app.openProject("TestProject.fry"));

fray::ProjectManager& project = app.project("TestProject");
ERR(project.set("project.version.major", 0));
ERR(project.set("project.version.minor", 0));
ERR(project.set("project.version.bug", 0));

std::string name;
F_long major;
ERR(project.get("project.name", name));
ERR(project.get("project.version.major", major));
ERR(project.close());
```

`project.name` is initialized from the archive or folder name when absent.
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

State changes are written to the working SQLite database immediately; the ZIP
archive is created or updated when the project closes. After the archive is
written successfully, the working folder is removed. Call `close()` explicitly
and check its result: if archiving fails, the working folder is retained and
closing can be retried. If cleanup fails, the archive is preserved and closing
can be retried to remove the remaining folder without rewriting the archive.
For safety, cleanup refuses filesystem roots, home directories, the current
working directory or its ancestors, and folders containing a `.git` entry.
`app.closeProject(name)` closes and removes a project from the manager;
`app.close()` closes all projects. Destructors attempt to close remaining
projects, but cannot report errors to the caller. References to a project or
state manager must not be used after its owner is closed or removed.

If both the archive and matching folder exist, `openProject` returns
`PROJECT_CONFLICT` by default. Ask the user which copy to open, then retry with
`fray::files::ConflictChoice::Archive` or `ConflictChoice::Folder`. The archive
choice extracts into a separate directory such as
`TestProject.archive-1/TestProject/`. The folder choice keeps the original
archive untouched and writes a separate archive such as
`TestProject.recovered-1/TestProject.fry` on close. Both paths retain the
project name and can be reopened. Only the working folder selected for the
project is removed after its archive is saved; an unselected folder is left
untouched. The engine's current startup prompts for
this choice when opening `TestProject.fry` in its working directory.

A `.fry.lock` sidecar prevents simultaneous opens by cooperating Fray
processes; do not delete it while a project is open. Do not modify a project's
files externally while it is open. Calls are not safe for concurrent use
without external synchronization. ZIP extraction rejects unsafe paths and
symbolic links, and archiving refuses symbolic links.

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
```
