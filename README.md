# Fray V0.0.0
A New Platform for Creatives & Developers

## Application state storage

Create and open a state manager before using it. `get` returns an error code
and writes the value to an output parameter:

```cpp
fray::state::StateManager state;
ERR(state.open("project.fray"));
ERR(state.set("application.engine.versionMajor", 1));
int version;
ERR(state.get("application.engine.versionMajor", version));
```

The code that creates a manager owns its lifetime and can pass it by reference
to other functions that need access. The manager closes its database when
destroyed; call `close()` to close it earlier.

Each plug-in can use its own table in the same database:

```cpp
fray::state::StateManager plugin;
ERR(plugin.open("project.fray", "examplePlugin"));
ERR(plugin.set("examplePlugin.field", "example value"));
std::string value;
ERR(plugin.get("examplePlugin.field", value));
```

Opening creates the named table if needed; setting a key creates or replaces
that entry. Dots are part of the key, not separate tables. `remove(key)` deletes
an entry, `renameTable(name)` renames the current table, and `removeTable()`
**deletes the current table and all its entries**. A later `set` recreates a
removed table. Reopen a renamed table using its new name.

Every successful `set` logs the key and complete value at info level, including
binary values as hexadecimal. Text and keys use byte escapes for control and
non-ASCII bytes. Avoid storing secrets in state if logs may be accessible.

Supported values are strings, signed 64-bit integers, finite doubles, booleans,
and `StateManager::Binary`. Getters return `STATE_NOT_FOUND` for missing entries,
`STATE_TYPE_MISMATCH` for the wrong type, and `STATE_VALUE_OUT_OF_RANGE` when a
numeric value cannot fit the requested type; their output remains unchanged on error. Keys and
table names must be nonempty and contain no null characters. Calls are
synchronous; a state object is not safe for concurrent calls without external
synchronization.

Databases from previous state-storage iterations are not migrated. Databases
containing the old state tables are rejected without modification; use a new
database instead.

The current engine startup uses an in-memory database as a demonstration; it
does not yet persist application state across restarts. Plug-in loading does
not yet automatically create state objects. Background saving, undo/redo, and
grouped transactions are not implemented.

On macOS, run the storage test with a path to a new, nonexistent database:

```sh
test_dir="$(mktemp -d)"
g++ -std=c++17 -IEngine -I/opt/homebrew/include tests/store_test.cpp tests/state_manager_link_test.cpp -L/opt/homebrew/lib -lsqlite3 -o "$test_dir/store-test"
"$test_dir/store-test" "$test_dir/state.sqlite" "$test_dir/legacy.sqlite"
```
