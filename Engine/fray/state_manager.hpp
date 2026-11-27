#ifndef FRAY_STATE_MANAGER_HPP
#define FRAY_STATE_MANAGER_HPP

#include <cmath>
#include <cstdio>
#include <cstdint>
#include <cstring>
#include <initializer_list>
#include <limits>
#include <memory>
#include <mutex>
#include <string>
#include <type_traits>
#include <variant>
#include <vector>

#include <sqlite3.h>

#include "types.hpp"
#include "errors.hpp"
#include "log_manager.hpp"
#include "file_manager.hpp"

namespace fray
{
    namespace state
    {
        class StateManager
        {
            public:
                using Binary = std::vector<std::uint8_t>;

            private:
                // Variant order defines the persisted type tags and must remain stable.
                using Value = std::variant<std::string, std::int64_t, double, bool, Binary>;
                using Statement = std::unique_ptr<sqlite3_stmt, decltype(&sqlite3_finalize)>;
                mutable std::recursive_mutex _mutex;
                sqlite3* _db = nullptr;
                std::string _table;
                fray::files::FileManager* _files = nullptr;
                std::weak_ptr<int> _filesLifetime;
                std::string _projectName;
                std::string _applicationId;

                F_bool projectAvailable()
                {
                    if (_files == nullptr || _filesLifetime.expired())
                    {
                        fray::log::engineError("Cannot access state: its file manager has been destroyed.");
                        return false;
                    }
                    return true;
                }

                F_void releaseProject()
                {
                    if (_files != nullptr && !_filesLifetime.expired())
                        _files->detach();
                    _files = nullptr;
                    _filesLifetime.reset();
                    _projectName.clear();
                    _applicationId.clear();
                }

                static std::string tableName(
                    const std::string& name)
                {
                    static constexpr F_char hex[] = "0123456789abcdef";
                    std::string result = "fray_state_";
                    for (unsigned char byte : name)
                    {
                        result += hex[byte >> 4];
                        result += hex[byte & 15];
                    }
                    return result;
                }

                F_bool createTable(
                    const std::string& name)
                {
                    F_bool exists;
                    if (!tableExists(name.c_str(), exists))
                        return false;
                    if (exists && !hasExpectedColumns(name.c_str(), {"key", "type", "value"}))
                        return false;
                    const std::string sql =
                        "CREATE TABLE IF NOT EXISTS " + name +
                        " (key TEXT PRIMARY KEY NOT NULL, type INTEGER NOT NULL, value NOT NULL, "
                        "CHECK((type = 1 AND typeof(value) = 'text') OR "
                        "(type = 2 AND typeof(value) = 'integer') OR "
                        "(type = 3 AND typeof(value) = 'real') OR "
                        "(type = 4 AND typeof(value) = 'integer' AND value IN (0, 1)) OR "
                        "(type = 5 AND typeof(value) = 'blob')))";
                    if (sqlite3_exec(_db, sql.c_str(), nullptr, nullptr, nullptr) != SQLITE_OK)
                    {
                        fray::log::engineError("Failed to create state table: %s", sqlite3_errmsg(_db));
                        return false;
                    }
                    return true;
                }

                F_void closeAfterOpenFailure()
                {
                    if (_db == nullptr)
                        return;
                    const int result = sqlite3_close_v2(_db);
                    if (result == SQLITE_OK)
                        _db = nullptr;
                    else
                        fray::log::engineError("Failed to close store: %s", sqlite3_errstr(result));
                }

                F_void rollback()
                {
                    if (sqlite3_exec(_db, "ROLLBACK", nullptr, nullptr, nullptr) != SQLITE_OK)
                        fray::log::engineError("Failed to roll back store transaction: %s", sqlite3_errmsg(_db));
                }

                F_bool validKey(
                    const std::string& key) const
                {
                    if (key.empty() || key.find('\0') != std::string::npos)
                    {
                        fray::log::engineError("State key must be nonempty and contain no null characters.");
                        return false;
                    }
                    return true;
                }

                F_bool tableExists(
                    const F_char* name,
                    F_bool& exists)
                {
                    sqlite3_stmt* raw = nullptr;
                    const int prepared = sqlite3_prepare_v2(_db,
                        "SELECT type FROM sqlite_master WHERE type IN ('table', 'view') AND name = ? COLLATE NOCASE",
                        -1, &raw, nullptr);
                    Statement statement(raw, sqlite3_finalize);
                    if (prepared != SQLITE_OK ||
                        sqlite3_bind_text(statement.get(), 1, name, -1, SQLITE_STATIC) != SQLITE_OK)
                    {
                        fray::log::engineError("Failed to inspect state tables: %s", sqlite3_errmsg(_db));
                        return false;
                    }
                    const int result = sqlite3_step(statement.get());
                    if (result != SQLITE_ROW && result != SQLITE_DONE)
                    {
                        fray::log::engineError("Failed to inspect state tables: %s", sqlite3_errmsg(_db));
                        return false;
                    }
                    if (result == SQLITE_ROW)
                    {
                        const auto* type = reinterpret_cast<const F_char*>(sqlite3_column_text(statement.get(), 0));
                        if (type == nullptr || std::strcmp(type, "table") != 0)
                        {
                            fray::log::engineError("Cannot open store: %s is not a table.", name);
                            return false;
                        }
                    }
                    exists = result == SQLITE_ROW;
                    return true;
                }

                F_bool hasExpectedColumns(
                    const F_char* table,
                    std::initializer_list<const F_char*> expected)
                {
                    sqlite3_stmt* raw = nullptr;
                    const int prepared = sqlite3_prepare_v2(_db, "SELECT name FROM pragma_table_xinfo(?)",
                                                            -1, &raw, nullptr);
                    Statement statement(raw, sqlite3_finalize);
                    if (prepared != SQLITE_OK ||
                        sqlite3_bind_text(statement.get(), 1, table, -1, SQLITE_STATIC) != SQLITE_OK)
                    {
                        fray::log::engineError("Failed to inspect state schema: %s", sqlite3_errmsg(_db));
                        return false;
                    }
                    std::size_t count = 0;
                    int result;
                    while ((result = sqlite3_step(statement.get())) == SQLITE_ROW)
                    {
                        const auto* name = reinterpret_cast<const F_char*>(sqlite3_column_text(statement.get(), 0));
                        F_bool found = false;
                        if (name != nullptr)
                            for (const F_char* candidate : expected)
                                if (std::strcmp(name, candidate) == 0)
                                    found = true;
                        if (!found)
                        {
                            fray::log::engineError("Invalid state table: unexpected column in %s.", table);
                            return false;
                        }
                        ++count;
                    }
                    if (result != SQLITE_DONE || count != expected.size())
                    {
                        fray::log::engineError("Invalid state schema for %s.", table);
                        return false;
                    }
                    return true;
                }

                F_err statementFailure(
                    Statement& statement,
                    const F_char* operation,
                    F_err failure)
                {
                    const std::string error = sqlite3_errmsg(_db);
                    statement.reset();
                    F_bool exists;
                    if (!tableExists(_table.c_str(), exists))
                        return failure;
                    if (!exists)
                    {
                        fray::log::engineError("State table not found.");
                        return fray::errors::STATE_NOT_FOUND;
                    }
                    fray::log::engineError("Failed to %s state: %s", operation, error.c_str());
                    return failure;
                }

                static std::string escaped(
                    const std::string& text)
                {
                    static constexpr F_char hex[] = "0123456789abcdef";
                    std::string result;
                    for (unsigned char byte : text)
                    {
                        if (byte == '\\' || byte == '"')
                        {
                            result += '\\';
                            result += static_cast<F_char>(byte);
                        }
                        else if (byte < 0x20 || byte >= 0x7f)
                        {
                            result += "\\x";
                            result += hex[byte >> 4];
                            result += hex[byte & 15];
                        }
                        else
                            result += static_cast<F_char>(byte);
                    }
                    return result;
                }

                static F_void logSet(
                    const std::string& key,
                    const Value& value)
                {
                    std::string formatted;
                    if (const auto* text = std::get_if<std::string>(&value))
                        formatted = "\"" + escaped(*text) + "\"";
                    else if (const auto* integer = std::get_if<std::int64_t>(&value))
                        formatted = std::to_string(*integer);
                    else if (const auto* real = std::get_if<double>(&value))
                    {
                        F_char buffer[128];
                        std::snprintf(buffer, sizeof(buffer), "%.*g", std::numeric_limits<double>::max_digits10, *real);
                        formatted = buffer;
                    }
                    else if (const auto* boolean = std::get_if<bool>(&value))
                        formatted = *boolean ? "true" : "false";
                    else
                    {
                        static constexpr F_char hex[] = "0123456789abcdef";
                        formatted = "0x";
                        for (std::uint8_t byte : std::get<Binary>(value))
                        {
                            formatted += hex[byte >> 4];
                            formatted += hex[byte & 15];
                        }
                    }
                    fray::log::engineInfo("Set state \"" + escaped(key) + "\" = " + formatted);
                }

                F_err write(
                    const std::string& key,
                    const Value& value,
                    F_bool retry = true)
                {
                    std::lock_guard<std::recursive_mutex> lock(_mutex);
                    if (_db == nullptr)
                    {
                        fray::log::engineError("Cannot save state: store is not open.");
                        return fray::errors::FAILED_SAVE_STATE;
                    }
                    if (!projectAvailable())
                        return fray::errors::FAILED_SAVE_STATE;
                    if (!validKey(key))
                        return fray::errors::INVALID_STATE_KEY;
                    if (const auto* real = std::get_if<double>(&value); real != nullptr && !std::isfinite(*real))
                    {
                        fray::log::engineError("Cannot save a non-finite floating-point value.");
                        return fray::errors::FAILED_SAVE_STATE;
                    }
                    sqlite3_stmt* raw = nullptr;
                    const std::string sql = "INSERT INTO " + _table +
                        " (key, type, value) VALUES (?, ?, ?) "
                        "ON CONFLICT(key) DO UPDATE SET type = excluded.type, value = excluded.value";
                    int prepared = sqlite3_prepare_v2(_db, sql.c_str(), -1, &raw, nullptr);
                    if (prepared != SQLITE_OK)
                    {
                        const std::string error = sqlite3_errmsg(_db);
                        sqlite3_finalize(raw);
                        raw = nullptr;
                        F_bool exists;
                        if (!tableExists(_table.c_str(), exists))
                            return fray::errors::FAILED_SAVE_STATE;
                        if (exists)
                        {
                            fray::log::engineError("Failed to save state: %s", error.c_str());
                            return fray::errors::FAILED_SAVE_STATE;
                        }
                        if (!retry || !createTable(_table))
                        {
                            fray::log::engineError("Failed to save state: %s", error.c_str());
                            return fray::errors::FAILED_SAVE_STATE;
                        }
                        retry = false;
                        prepared = sqlite3_prepare_v2(_db, sql.c_str(), -1, &raw, nullptr);
                    }
                    Statement statement(raw, sqlite3_finalize);
                    if (prepared != SQLITE_OK)
                    {
                        fray::log::engineError("Failed to save state: %s", sqlite3_errmsg(_db));
                        return fray::errors::FAILED_SAVE_STATE;
                    }
                    int bound = sqlite3_bind_text64(statement.get(), 1, key.data(), key.size(), SQLITE_TRANSIENT, SQLITE_UTF8);
                    if (bound == SQLITE_OK)
                        bound = sqlite3_bind_int(statement.get(), 2, static_cast<int>(value.index()) + 1);
                    if (bound == SQLITE_OK)
                    {
                        if (const auto* text = std::get_if<std::string>(&value))
                            bound = sqlite3_bind_text64(statement.get(), 3, text->data(), text->size(), SQLITE_TRANSIENT, SQLITE_UTF8);
                        else if (const auto* integer = std::get_if<std::int64_t>(&value))
                            bound = sqlite3_bind_int64(statement.get(), 3, *integer);
                        else if (const auto* real = std::get_if<double>(&value))
                            bound = sqlite3_bind_double(statement.get(), 3, *real);
                        else if (const auto* boolean = std::get_if<bool>(&value))
                            bound = sqlite3_bind_int(statement.get(), 3, *boolean ? 1 : 0);
                        else
                        {
                            const auto& binary = std::get<Binary>(value);
                            bound = binary.empty()
                                ? sqlite3_bind_zeroblob(statement.get(), 3, 0)
                                : sqlite3_bind_blob64(statement.get(), 3, binary.data(), binary.size(), SQLITE_TRANSIENT);
                        }
                    }
                    if (bound != SQLITE_OK)
                    {
                        fray::log::engineError("Failed to save state: %s", sqlite3_errmsg(_db));
                        return fray::errors::FAILED_SAVE_STATE;
                    }
                    if (sqlite3_step(statement.get()) != SQLITE_DONE)
                    {
                        const std::string error = sqlite3_errmsg(_db);
                        statement.reset();
                        F_bool exists;
                        if (!tableExists(_table.c_str(), exists))
                            return fray::errors::FAILED_SAVE_STATE;
                        if (!exists && retry && createTable(_table))
                            return write(key, value, false);
                        fray::log::engineError("Failed to save state: %s", error.c_str());
                        return fray::errors::FAILED_SAVE_STATE;
                    }
                    statement.reset();
                    logSet(key, value);
                    return fray::errors::NONE;
                }

                template<typename T>
                F_err read(
                    const std::string& key,
                    T& output,
                    int expectedType)
                {
                    std::lock_guard<std::recursive_mutex> lock(_mutex);
                    if (_db == nullptr)
                    {
                        fray::log::engineError("Cannot load state: store is not open.");
                        return fray::errors::FAILED_LOAD_STATE;
                    }
                    if (!projectAvailable())
                        return fray::errors::FAILED_LOAD_STATE;
                    if (!validKey(key))
                        return fray::errors::INVALID_STATE_KEY;
                    sqlite3_stmt* raw = nullptr;
                    const std::string sql = "SELECT type, value FROM " + _table + " WHERE key = ?";
                    const int prepared = sqlite3_prepare_v2(_db, sql.c_str(), -1, &raw, nullptr);
                    Statement statement(raw, sqlite3_finalize);
                    if (prepared != SQLITE_OK)
                    {
                        return statementFailure(statement, "load", fray::errors::FAILED_LOAD_STATE);
                    }
                    if (sqlite3_bind_text64(statement.get(), 1, key.data(), key.size(), SQLITE_TRANSIENT, SQLITE_UTF8) != SQLITE_OK)
                    {
                        fray::log::engineError("Failed to load state: %s", sqlite3_errmsg(_db));
                        return fray::errors::FAILED_LOAD_STATE;
                    }
                    const int result = sqlite3_step(statement.get());
                    if (result == SQLITE_DONE)
                    {
                        fray::log::engineError("State key not found: %s", key.c_str());
                        return fray::errors::STATE_NOT_FOUND;
                    }
                    if (result != SQLITE_ROW)
                    {
                        return statementFailure(statement, "load", fray::errors::FAILED_LOAD_STATE);
                    }
                    if (sqlite3_column_type(statement.get(), 0) != SQLITE_INTEGER)
                    {
                        fray::log::engineError("Failed to load state: invalid value type.");
                        return fray::errors::FAILED_LOAD_STATE;
                    }
                    const sqlite3_int64 storedType = sqlite3_column_int64(statement.get(), 0);
                    if (storedType < 1 || storedType > 5)
                        return invalidStoredValue();
                    if (storedType != expectedType)
                    {
                        fray::log::engineError("Cannot load state: value type does not match.");
                        return fray::errors::STATE_TYPE_MISMATCH;
                    }
                    if constexpr (std::is_same_v<T, std::string>)
                    {
                        if (sqlite3_column_type(statement.get(), 1) != SQLITE_TEXT)
                            return invalidStoredValue();
                        const auto* text = reinterpret_cast<const char*>(sqlite3_column_text(statement.get(), 1));
                        if (text == nullptr)
                            return invalidStoredValue();
                        output.assign(text, sqlite3_column_bytes(statement.get(), 1));
                    }
                    else if constexpr (std::is_same_v<T, std::int64_t>)
                    {
                        if (sqlite3_column_type(statement.get(), 1) != SQLITE_INTEGER)
                            return invalidStoredValue();
                        output = sqlite3_column_int64(statement.get(), 1);
                    }
                    else if constexpr (std::is_same_v<T, double>)
                    {
                        if (sqlite3_column_type(statement.get(), 1) != SQLITE_FLOAT ||
                            !std::isfinite(sqlite3_column_double(statement.get(), 1)))
                            return invalidStoredValue();
                        output = sqlite3_column_double(statement.get(), 1);
                    }
                    else if constexpr (std::is_same_v<T, bool>)
                    {
                        if (sqlite3_column_type(statement.get(), 1) != SQLITE_INTEGER)
                            return invalidStoredValue();
                        const auto number = sqlite3_column_int64(statement.get(), 1);
                        if (number != 0 && number != 1)
                            return invalidStoredValue();
                        output = number != 0;
                    }
                    else
                    {
                        if (sqlite3_column_type(statement.get(), 1) != SQLITE_BLOB)
                            return invalidStoredValue();
                        const int size = sqlite3_column_bytes(statement.get(), 1);
                        const auto* bytes = static_cast<const std::uint8_t*>(sqlite3_column_blob(statement.get(), 1));
                        if (size > 0 && bytes == nullptr)
                            return invalidStoredValue();
                        if (size == 0)
                            output.clear();
                        else
                            output.assign(bytes, bytes + size);
                    }
                    return fray::errors::NONE;
                }

                F_err invalidStoredValue()
                {
                    fray::log::engineError("Failed to load state: invalid stored value.");
                    return fray::errors::FAILED_LOAD_STATE;
                }

            public:
                StateManager() = default;
                StateManager(
                    const StateManager&) = delete;
                StateManager& operator=(
                    const StateManager&) = delete;

                ~StateManager()
                {
                    if (_db != nullptr)
                    {
                        const int result = sqlite3_close_v2(_db);
                        if (result != SQLITE_OK)
                            fray::log::engineError("Failed to close store: %s", sqlite3_errstr(result));
                    }
                    releaseProject();
                }

                F_err open(
                    fray::files::FileManager& files,
                    const std::string& table = "Fray",
                    const std::string& applicationId = "")
                {
                    std::lock_guard<std::recursive_mutex> lock(_mutex);
                    if (!files.isOpen())
                    {
                        fray::log::engineError("Cannot open state: project is not open.");
                        return fray::errors::FAILED_OPEN_STORE;
                    }
                    if (_db != nullptr || table.empty() || table.find('\0') != std::string::npos)
                    {
                        fray::log::engineError("Cannot open store: invalid table or a database is already open.");
                        return fray::errors::FAILED_OPEN_STORE;
                    }
                    std::filesystem::path path;
                    if (files.filePath(files.projectName() + ".sqlite", path) != fray::errors::NONE)
                        return fray::errors::FAILED_OPEN_STORE;
                    std::error_code pathError;
                    const auto status = std::filesystem::symlink_status(path, pathError);
                    if ((pathError && pathError != std::errc::no_such_file_or_directory) ||
                        std::filesystem::is_symlink(status))
                    {
                        fray::log::engineError("Cannot open project database: invalid file path.");
                        return fray::errors::FAILED_OPEN_STORE;
                    }
                    const std::string filename = path.string();
                    const int result = sqlite3_open(filename.c_str(), &_db);
                    if (result != SQLITE_OK)
                    {
                        fray::log::engineError("Failed to open store: %s",
                            _db != nullptr ? sqlite3_errmsg(_db) : sqlite3_errstr(result));
                        closeAfterOpenFailure();
                        return fray::errors::FAILED_OPEN_STORE;
                    }
                    if (sqlite3_exec(_db, "BEGIN IMMEDIATE", nullptr, nullptr, nullptr) != SQLITE_OK)
                    {
                        fray::log::engineError("Failed to begin store initialization: %s", sqlite3_errmsg(_db));
                        closeAfterOpenFailure();
                        return fray::errors::FAILED_OPEN_STORE;
                    }
                    const std::string requestedTable = tableName(table);
                    if (!createTable(requestedTable))
                    {
                        rollback();
                        closeAfterOpenFailure();
                        return fray::errors::FAILED_OPEN_STORE;
                    }
                    if (sqlite3_exec(_db, "COMMIT", nullptr, nullptr, nullptr) != SQLITE_OK)
                    {
                        fray::log::engineError("Failed to commit store initialization: %s", sqlite3_errmsg(_db));
                        rollback();
                        closeAfterOpenFailure();
                        return fray::errors::FAILED_OPEN_STORE;
                    }
                    _table = requestedTable;
                    _files = &files;
                    _filesLifetime = files.lifetime();
                    _projectName = files.projectName();
                    _applicationId = applicationId;
                    files.attach();
                    return fray::errors::NONE;
                }

                const std::string& projectName() const { return _projectName; }
                const std::string& applicationId() const { return _applicationId; }
                bool isOpen() const
                {
                    std::lock_guard<std::recursive_mutex> lock(_mutex);
                    return _db != nullptr;
                }

                // Held by the owner while it closes and reopens the database around a file rename.
                std::recursive_mutex& mutex() { return _mutex; }

                F_err close()
                {
                    std::lock_guard<std::recursive_mutex> lock(_mutex);
                    if (_db == nullptr)
                    {
                        fray::log::engineError("Cannot close store: no database is open.");
                        return fray::errors::FAILED_CLOSE_STORE;
                    }
                    const int result = sqlite3_close_v2(_db);
                    if (result != SQLITE_OK)
                    {
                        fray::log::engineError("Failed to close store: %s", sqlite3_errstr(result));
                        return fray::errors::FAILED_CLOSE_STORE;
                    }
                    _db = nullptr;
                    _table.clear();
                    releaseProject();
                    return fray::errors::NONE;
                }

                F_err set(
                    const std::string& key,
                    const std::string& value) { return write(key, Value(value)); }
                F_err set(
                    const std::string& key,
                    const F_char* value)
                {
                    if (value == nullptr)
                    {
                        fray::log::engineError("Cannot save state: string value is null.");
                        return fray::errors::FAILED_SAVE_STATE;
                    }
                    return set(key, std::string(value));
                }
                F_err set(
                    const std::string& key,
                    double value) { return write(key, Value(value)); }
                F_err set(
                    const std::string& key,
                    bool value) { return write(key, Value(value)); }
                F_err set(
                    const std::string& key,
                    const Binary& value) { return write(key, Value(value)); }

                template<typename T, std::enable_if_t<std::is_integral_v<T> && !std::is_same_v<T, bool>, int> = 0>
                F_err set(
                    const std::string& key,
                    T value)
                {
                    if constexpr (std::is_unsigned_v<T>)
                    {
                        if (static_cast<std::uintmax_t>(value) >
                            static_cast<std::uintmax_t>(std::numeric_limits<std::int64_t>::max()))
                        {
                            fray::log::engineError("Cannot save state: integer is out of range.");
                            return fray::errors::STATE_VALUE_OUT_OF_RANGE;
                        }
                    }
                    return write(key, Value(static_cast<std::int64_t>(value)));
                }

                F_err get(
                    const std::string& key,
                    std::string& value) { return read(key, value, 1); }
                F_err get(
                    const std::string& key,
                    double& value) { return read(key, value, 3); }
                F_err get(
                    const std::string& key,
                    bool& value) { return read(key, value, 4); }
                F_err get(
                    const std::string& key,
                    Binary& value) { return read(key, value, 5); }

                F_err contains(
                    const std::string& key,
                    F_bool& exists)
                {
                    std::lock_guard<std::recursive_mutex> lock(_mutex);
                    if (_db == nullptr)
                    {
                        fray::log::engineError("Cannot inspect state: store is not open.");
                        return fray::errors::FAILED_LOAD_STATE;
                    }
                    if (!projectAvailable())
                        return fray::errors::FAILED_LOAD_STATE;
                    if (!validKey(key))
                        return fray::errors::INVALID_STATE_KEY;
                    sqlite3_stmt* raw = nullptr;
                    const std::string sql = "SELECT 1 FROM " + _table + " WHERE key = ?";
                    const int prepared = sqlite3_prepare_v2(_db, sql.c_str(), -1, &raw, nullptr);
                    Statement statement(raw, sqlite3_finalize);
                    if (prepared != SQLITE_OK)
                        return statementFailure(statement, "inspect", fray::errors::FAILED_LOAD_STATE);
                    if (sqlite3_bind_text64(statement.get(), 1, key.data(), key.size(), SQLITE_TRANSIENT, SQLITE_UTF8) != SQLITE_OK)
                    {
                        fray::log::engineError("Failed to inspect state: %s", sqlite3_errmsg(_db));
                        return fray::errors::FAILED_LOAD_STATE;
                    }
                    const int result = sqlite3_step(statement.get());
                    if (result != SQLITE_ROW && result != SQLITE_DONE)
                        return statementFailure(statement, "inspect", fray::errors::FAILED_LOAD_STATE);
                    exists = result == SQLITE_ROW;
                    return fray::errors::NONE;
                }

                F_err get(
                    const std::string& key,
                    float& value)
                {
                    double stored;
                    const F_err result = read(key, stored, 3);
                    if (result != fray::errors::NONE)
                        return result;
                    if (std::abs(stored) > std::numeric_limits<float>::max() ||
                        (stored != 0 && std::abs(stored) < std::numeric_limits<float>::denorm_min()))
                    {
                        fray::log::engineError("Cannot load state: floating-point value is out of range.");
                        return fray::errors::STATE_VALUE_OUT_OF_RANGE;
                    }
                    value = static_cast<float>(stored);
                    return fray::errors::NONE;
                }

                template<typename T, std::enable_if_t<std::is_integral_v<T> && !std::is_same_v<T, bool>, int> = 0>
                F_err get(
                    const std::string& key,
                    T& value)
                {
                    std::int64_t stored;
                    const F_err result = read(key, stored, 2);
                    if (result != fray::errors::NONE)
                        return result;
                    F_bool inRange = true;
                    if constexpr (std::is_signed_v<T>)
                    {
                        if constexpr (std::numeric_limits<T>::digits < std::numeric_limits<std::int64_t>::digits)
                            inRange = stored >= static_cast<std::int64_t>(std::numeric_limits<T>::min()) &&
                                      stored <= static_cast<std::int64_t>(std::numeric_limits<T>::max());
                    }
                    else
                        inRange = stored >= 0 &&
                                  static_cast<std::uint64_t>(stored) <= std::numeric_limits<T>::max();
                    if (!inRange)
                    {
                        fray::log::engineError("Cannot load state: integer is out of range.");
                        return fray::errors::STATE_VALUE_OUT_OF_RANGE;
                    }
                    value = static_cast<T>(stored);
                    return fray::errors::NONE;
                }

                F_err remove(
                    const std::string& key)
                {
                    std::lock_guard<std::recursive_mutex> lock(_mutex);
                    if (_db == nullptr)
                    {
                        fray::log::engineError("Cannot remove state: store is not open.");
                        return fray::errors::FAILED_REMOVE_STATE;
                    }
                    if (!projectAvailable())
                        return fray::errors::FAILED_REMOVE_STATE;
                    if (!validKey(key))
                        return fray::errors::INVALID_STATE_KEY;
                    sqlite3_stmt* raw = nullptr;
                    const std::string sql = "DELETE FROM " + _table + " WHERE key = ?";
                    const int prepared = sqlite3_prepare_v2(_db, sql.c_str(), -1, &raw, nullptr);
                    Statement statement(raw, sqlite3_finalize);
                    if (prepared != SQLITE_OK)
                    {
                        return statementFailure(statement, "remove", fray::errors::FAILED_REMOVE_STATE);
                    }
                    if (sqlite3_bind_text64(statement.get(), 1, key.data(), key.size(), SQLITE_TRANSIENT, SQLITE_UTF8) != SQLITE_OK)
                    {
                        fray::log::engineError("Failed to remove state: %s", sqlite3_errmsg(_db));
                        return fray::errors::FAILED_REMOVE_STATE;
                    }
                    if (sqlite3_step(statement.get()) != SQLITE_DONE)
                    {
                        return statementFailure(statement, "remove", fray::errors::FAILED_REMOVE_STATE);
                    }
                    if (sqlite3_changes(_db) == 0)
                    {
                        fray::log::engineError("State key not found: %s", key.c_str());
                        return fray::errors::STATE_NOT_FOUND;
                    }
                    statement.reset();
                    return fray::errors::NONE;
                }

                F_err removeTable()
                {
                    std::lock_guard<std::recursive_mutex> lock(_mutex);
                    if (_db == nullptr)
                    {
                        fray::log::engineError("Cannot remove state table: store is not open.");
                        return fray::errors::FAILED_REMOVE_STATE;
                    }
                    if (!projectAvailable())
                        return fray::errors::FAILED_REMOVE_STATE;
                    F_bool exists;
                    if (!tableExists(_table.c_str(), exists))
                        return fray::errors::FAILED_REMOVE_STATE;
                    if (!exists)
                    {
                        fray::log::engineError("State table not found.");
                        return fray::errors::STATE_NOT_FOUND;
                    }
                    const std::string sql = "DROP TABLE " + _table;
                    if (sqlite3_exec(_db, sql.c_str(), nullptr, nullptr, nullptr) != SQLITE_OK)
                    {
                        fray::log::engineError("Failed to remove state table: %s", sqlite3_errmsg(_db));
                        return fray::errors::FAILED_REMOVE_STATE;
                    }
                    return fray::errors::NONE;
                }

                F_err renameTable(
                    const std::string& name)
                {
                    std::lock_guard<std::recursive_mutex> lock(_mutex);
                    if (_db == nullptr || name.empty() || name.find('\0') != std::string::npos)
                    {
                        fray::log::engineError("Cannot rename state table: store is not open or name is invalid.");
                        return fray::errors::FAILED_RENAME_STATE_TABLE;
                    }
                    if (!projectAvailable())
                        return fray::errors::FAILED_RENAME_STATE_TABLE;
                    F_bool exists;
                    if (!tableExists(_table.c_str(), exists))
                        return fray::errors::FAILED_RENAME_STATE_TABLE;
                    if (!exists)
                    {
                        fray::log::engineError("State table not found.");
                        return fray::errors::STATE_NOT_FOUND;
                    }
                    const std::string renamed = tableName(name);
                    if (renamed == _table)
                        return fray::errors::NONE;
                    if (!tableExists(renamed.c_str(), exists))
                        return fray::errors::FAILED_RENAME_STATE_TABLE;
                    if (exists)
                    {
                        fray::log::engineError("Cannot rename state table: destination already exists.");
                        return fray::errors::FAILED_RENAME_STATE_TABLE;
                    }
                    const std::string sql = "ALTER TABLE " + _table + " RENAME TO " + renamed;
                    if (sqlite3_exec(_db, sql.c_str(), nullptr, nullptr, nullptr) != SQLITE_OK)
                    {
                        fray::log::engineError("Failed to rename state table: %s", sqlite3_errmsg(_db));
                        return fray::errors::FAILED_RENAME_STATE_TABLE;
                    }
                    _table = renamed;
                    return fray::errors::NONE;
                }
        };
    }
}

#endif
