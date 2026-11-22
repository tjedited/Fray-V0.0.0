# Fray V0.0.0
A New Platform for Creatives & Developers

## Application state storage

Create a file manager for a `.fry` project, then open a state manager using
it. `get` returns an error code and writes the value to an output parameter:

```cpp
fray::files::FileManager project;
ERR(project.open("project.fry"));
fray::state::StateManager state;
ERR(state.open(project));
ERR(state.set("application.engine.versionMajor", 1));
int version;
ERR(state.get("application.engine.versionMajor", version));
```

The file manager must outlive the state managers using it. Pass managers by
reference to functions that need them. A state manager closes its database
when destroyed; call `close()` to close it earlier.

Each plug-in can use its own table in the same database:

```cpp
fray::state::StateManager plugin;
ERR(plugin.open(project, "examplePlugin"));
ERR(plugin.set("examplePlugin.field", "example value"));
std::string value;
ERR(plugin.get("examplePlugin.field", value));
```

Opening creates the named table if needed; setting a key creates or replaces
that entry. Dots are part of the key, not separate tables. `remove(key)` deletes
an entry, `renameTable(name)` renames the current table, and `removeTable()`
**deletes the current table and all its entries**. A later `set` recreates a
removed table. Reopen a renamed table using its new name.

`.fry` files are ZIP archives containing `state.sqlite`; other archive entries
are preserved when saving. The file manager keeps a temporary working database
and saves a consistent SQLite snapshot after every state change, including
table creation, removal, and rename. Rewriting the archive synchronously on
every change may be expensive for large projects. The file manager does not yet
provide an API for adding or reading other project files.

If saving fails, the operation returns an error but its change may already be
present in the working database. Restore access to the project and call
`project.save()` to retry. Closing a project with unsaved changes fails; if
the file manager is destroyed, it logs the retained workspace path for
recovery. A `.fry.lock` sidecar prevents simultaneous opens by cooperating
Fray processes; do not delete it while a project is open. Calls are not safe
for concurrent use without external synchronization.

Every successful `set` logs the key and complete value at info level, including
binary values as hexadecimal. Text and keys use byte escapes for control and
non-ASCII bytes. Avoid storing secrets in state if logs may be accessible.

Supported values are strings, signed 64-bit integers, finite doubles, booleans,
and `StateManager::Binary`. Getters return `STATE_NOT_FOUND` for missing entries,
`STATE_TYPE_MISMATCH` for the wrong type, and `STATE_VALUE_OUT_OF_RANGE` when a
numeric value cannot fit the requested type; their output remains unchanged on error. Keys and
table names must be nonempty and contain no null characters.

Databases from previous state-storage iterations are not migrated. Databases
containing the old state tables are rejected without modification; use a new
database instead.

The current engine startup still uses an in-memory database as a demonstration;
it does not yet open a project. Plug-in loading does not yet automatically
create state objects. Background saving, undo/redo, and grouped transactions
are not implemented.

The engine requires SQLite and libzip (for example, Homebrew `sqlite` and
`libzip` on macOS, or the corresponding vcpkg packages on Windows). On macOS,
run the storage tests with paths to new, nonexistent files:

```sh
test_dir="$(mktemp -d)"
g++ -std=c++17 -IEngine -I/opt/homebrew/include tests/store_test.cpp tests/state_manager_link_test.cpp -L/opt/homebrew/lib -lsqlite3 -lzip -o "$test_dir/store-test"
"$test_dir/store-test" "$test_dir/state.sqlite" "$test_dir/legacy.sqlite"
g++ -std=c++17 -IEngine -I/opt/homebrew/include tests/file_manager_test.cpp -L/opt/homebrew/lib -lsqlite3 -lzip -o "$test_dir/file-manager-test"
"$test_dir/file-manager-test" "$test_dir/project.fry" "$test_dir/invalid.fry"
```
