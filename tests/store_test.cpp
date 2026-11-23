#include "fray/state_manager.hpp"

#include <sqlite3.h>

#include <cassert>
#include <cstdio>
#include <cstdint>
#include <filesystem>
#include <fstream>
#include <limits>
#include <string>

#ifdef _WIN32
#include <io.h>
#define test_dup _dup
#define test_dup2 _dup2
#define test_fileno _fileno
#define test_close _close
#else
#include <unistd.h>
#define test_dup dup
#define test_dup2 dup2
#define test_fileno fileno
#define test_close close
#endif

using fray::state::StateManager;

F_err verifyStateManagerSeparateTranslationUnit(StateManager& state, int& value);

static void execute(const char* path, const char* sql)
{
    sqlite3* db = nullptr;
    assert(sqlite3_open(path, &db) == SQLITE_OK);
    assert(sqlite3_exec(db, sql, nullptr, nullptr, nullptr) == SQLITE_OK);
    assert(sqlite3_close(db) == SQLITE_OK);
}

static std::string databasePath(const char* path)
{
    const std::filesystem::path archive(path);
    const auto name = archive.stem();
    return (archive.parent_path() / name / (name.string() + ".sqlite")).string();
}

static void mutateProject(const char* path, const char* sql)
{
    execute(databasePath(path).c_str(), sql);
}

static std::int64_t readInteger(StateManager& manager, const char* key)
{
    std::int64_t value = -1;
    assert(manager.get(key, value) == fray::errors::NONE);
    return value;
}

static void testSetLogging(const char* path)
{
    {
        fray::files::FileManager project;
        assert(project.open(path) == fray::errors::NONE);
        StateManager manager;
        assert(manager.open(project, "logging") == fray::errors::NONE);
    }
    mutateProject(path, "CREATE TRIGGER reject_logging_update BEFORE UPDATE ON fray_state_6c6f6767696e67 "
                        "WHEN OLD.key = 'blocked' BEGIN SELECT RAISE(ABORT, 'blocked'); END");
    FILE* capture = std::tmpfile();
    assert(capture != nullptr);
    std::fflush(stdout);
    const int saved = test_dup(test_fileno(stdout));
    assert(saved >= 0);
    assert(test_dup2(test_fileno(capture), test_fileno(stdout)) >= 0);
    {
        fray::files::FileManager project;
        assert(project.open(path) == fray::errors::NONE);
        StateManager manager;
        StateManager mirror;
        assert(manager.open(project, "logging") == fray::errors::NONE);
        assert(mirror.open(project, "logging") == fray::errors::NONE);
        assert(manager.set("text\nkey", std::string("a\0\"\\b", 5)) == fray::errors::NONE);
        assert(manager.set("integer", std::numeric_limits<std::int64_t>::min()) == fray::errors::NONE);
        assert(manager.set("real", 1.2345678901234567) == fray::errors::NONE);
        assert(manager.set("boolean", false) == fray::errors::NONE);
        assert(manager.set("binary", StateManager::Binary{0, 1, 255}) == fray::errors::NONE);
        assert(manager.set("long", std::string(2000, 'x')) == fray::errors::NONE);
        assert(manager.set("long-binary", StateManager::Binary(1200, 0xab)) == fray::errors::NONE);
        assert(manager.set("blocked", 1) == fray::errors::NONE);
        assert(manager.set("blocked", 2) == fray::errors::FAILED_SAVE_STATE);
        assert(manager.set("failed", std::numeric_limits<double>::infinity()) == fray::errors::FAILED_SAVE_STATE);
        assert(manager.removeTable() == fray::errors::NONE);
        assert(mirror.set("retry", 8) == fray::errors::NONE);
    }
    std::fflush(stdout);
    assert(test_dup2(saved, test_fileno(stdout)) >= 0);
    assert(test_close(saved) == 0);
    std::rewind(capture);
    std::string output;
    char buffer[1024];
    std::size_t count;
    while ((count = std::fread(buffer, 1, sizeof(buffer), capture)) != 0)
        output.append(buffer, count);
    assert(std::ferror(capture) == 0);
    assert(std::fclose(capture) == 0);

    assert(output.find("Set state \"text\\x0akey\" = \"a\\x00\\\"\\\\b\"") != std::string::npos);
    assert(output.find("Set state \"integer\" = -9223372036854775808") != std::string::npos);
    assert(output.find("Set state \"real\" = 1.2345678901234567") != std::string::npos);
    assert(output.find("Set state \"boolean\" = false") != std::string::npos);
    assert(output.find("Set state \"binary\" = 0x0001ff") != std::string::npos);
    assert(output.find("Set state \"long\" = \"" + std::string(2000, 'x') + "\"") != std::string::npos);
    std::string longBinary;
    for (int i = 0; i < 1200; ++i)
        longBinary += "ab";
    assert(output.find("Set state \"long-binary\" = 0x" + longBinary) != std::string::npos);
    assert(output.find("Set state \"blocked\" = 1") != std::string::npos);
    assert(output.find("Set state \"blocked\" = 2") == std::string::npos);
    assert(output.find("Set state \"failed\"") == std::string::npos);
    const std::string retry = "Set state \"retry\" = 8";
    const std::size_t retryPos = output.find(retry);
    assert(retryPos != std::string::npos && output.find(retry, retryPos + retry.size()) == std::string::npos);
}

int main(int argc, char** argv)
{
    assert(argc == 3);
    testSetLogging(argv[1]);
    fray::files::FileManager project;
    assert(project.open(argv[1]) == fray::errors::NONE);
    {
        StateManager manager;
        fray::files::FileManager unopened;
        assert(manager.open(unopened) == fray::errors::FAILED_OPEN_STORE);
        assert(manager.open(project, "") == fray::errors::FAILED_OPEN_STORE);
        assert(manager.open(project, std::string("a\0b", 3)) == fray::errors::FAILED_OPEN_STORE);
        int shared = 0;
        assert(verifyStateManagerSeparateTranslationUnit(manager, shared) == fray::errors::FAILED_LOAD_STATE);
        std::string text;
        assert(manager.get("key", text) == fray::errors::FAILED_LOAD_STATE);
        assert(manager.set("key", "value") == fray::errors::FAILED_SAVE_STATE);
        assert(manager.open(project) == fray::errors::NONE);
        assert(manager.open(project) == fray::errors::FAILED_OPEN_STORE);
        text = "unchanged";
        assert(manager.get("missing", text) == fray::errors::STATE_NOT_FOUND);
        assert(text == "unchanged");
        assert(manager.set("", "value") == fray::errors::INVALID_STATE_KEY);
        assert(manager.set("null", nullptr) == fray::errors::FAILED_SAVE_STATE);
        assert(manager.get(std::string("a\0b", 3), text) == fray::errors::INVALID_STATE_KEY);
        assert(manager.set("text", std::string("hello\0world", 11)) == fray::errors::NONE);
        assert(manager.set("empty-text", "") == fray::errors::NONE);
        assert(manager.set("min", std::numeric_limits<std::int64_t>::min()) == fray::errors::NONE);
        assert(manager.set("max", std::numeric_limits<std::int64_t>::max()) == fray::errors::NONE);
        assert(manager.set("real", 3.25) == fray::errors::NONE);
        assert(manager.set("real", std::numeric_limits<double>::quiet_NaN()) == fray::errors::FAILED_SAVE_STATE);
        assert(manager.set("real", std::numeric_limits<double>::infinity()) == fray::errors::FAILED_SAVE_STATE);
        assert(manager.set("bool", true) == fray::errors::NONE);
        assert(manager.set("false", false) == fray::errors::NONE);
        assert(manager.set("binary", StateManager::Binary{0, 1, 255}) == fray::errors::NONE);
        assert(manager.set("empty-binary", StateManager::Binary{}) == fray::errors::NONE);
        assert(manager.set("x'); DROP TABLE state_values;--", "safe") == fray::errors::NONE);
        std::int64_t number = 42;
        assert(manager.get("bool", number) == fray::errors::STATE_TYPE_MISMATCH);
        assert(number == 42);
        assert(manager.set("retyped", "value") == fray::errors::NONE);
        assert(manager.set("retyped", 9) == fray::errors::NONE);
        assert(manager.get("retyped", text) == fray::errors::STATE_TYPE_MISMATCH);
        assert(readInteger(manager, "retyped") == 9);
    }

    {
        StateManager manager;
        assert(manager.open(project) == fray::errors::NONE);
        std::string text;
        assert(manager.get("text", text) == fray::errors::NONE);
        assert(text == std::string("hello\0world", 11));
        assert(manager.get("empty-text", text) == fray::errors::NONE && text.empty());
        assert(readInteger(manager, "min") == std::numeric_limits<std::int64_t>::min());
        assert(readInteger(manager, "max") == std::numeric_limits<std::int64_t>::max());
        double real = 0;
        assert(manager.get("real", real) == fray::errors::NONE && real == 3.25);
        bool boolean = false;
        assert(manager.get("bool", boolean) == fray::errors::NONE && boolean);
        boolean = true;
        assert(manager.get("false", boolean) == fray::errors::NONE && !boolean);
        StateManager::Binary binary;
        assert(manager.get("binary", binary) == fray::errors::NONE);
        assert((binary == StateManager::Binary{0, 1, 255}));
        assert(manager.get("empty-binary", binary) == fray::errors::NONE && binary.empty());
        assert(manager.get("x'); DROP TABLE state_values;--", text) == fray::errors::NONE && text == "safe");
    }

    {
        StateManager state;
        assert(state.open(project) == fray::errors::NONE);
        assert(state.set("shared", 123) == fray::errors::NONE);
        int shared = 0;
        assert(verifyStateManagerSeparateTranslationUnit(state, shared) == fray::errors::NONE && shared == 123);
        assert(state.set("application.engine.versionMajor", 1) == fray::errors::NONE);
        int version = 0;
        assert(state.get("application.engine.versionMajor", version) == fray::errors::NONE && version == 1);
        assert(state.set("large", std::numeric_limits<std::int64_t>::max()) == fray::errors::NONE);
        version = 7;
        assert(state.get("large", version) == fray::errors::STATE_VALUE_OUT_OF_RANGE && version == 7);
        assert(state.set("too-large", std::numeric_limits<std::uint64_t>::max()) == fray::errors::STATE_VALUE_OUT_OF_RANGE);
        assert(state.set("negative", -1) == fray::errors::NONE);
        unsigned int unsignedValue = 7;
        assert(state.get("negative", unsignedValue) == fray::errors::STATE_VALUE_OUT_OF_RANGE && unsignedValue == 7);
        assert(state.remove("shared") == fray::errors::NONE);
        assert(state.remove("shared") == fray::errors::STATE_NOT_FOUND);

        StateManager plugin;
        assert(plugin.open(project, "examplePlugin") == fray::errors::NONE);
        assert(plugin.set("examplePlugin.field", "example value") == fray::errors::NONE);
        assert(plugin.set("application.engine.versionMajor", 9) == fray::errors::NONE);
        assert(plugin.set("boolean", true) == fray::errors::NONE);
        assert(plugin.set("real", 1.25) == fray::errors::NONE);
        assert(plugin.set("float", 1.5f) == fray::errors::NONE);
        assert(plugin.set("binary", StateManager::Binary{0, 255}) == fray::errors::NONE);
        std::string text;
        assert(plugin.get("examplePlugin.field", text) == fray::errors::NONE && text == "example value");
        bool boolean = false;
        double real = 0;
        float floatValue = 0;
        StateManager::Binary binary;
        assert(plugin.get("boolean", boolean) == fray::errors::NONE && boolean);
        assert(plugin.get("real", real) == fray::errors::NONE && real == 1.25);
        assert(plugin.get("float", floatValue) == fray::errors::NONE && floatValue == 1.5f);
        assert(plugin.set("too-small", std::numeric_limits<double>::denorm_min()) == fray::errors::NONE);
        assert(plugin.get("too-small", floatValue) == fray::errors::STATE_VALUE_OUT_OF_RANGE && floatValue == 1.5f);
        assert(plugin.get("binary", binary) == fray::errors::NONE && (binary == StateManager::Binary{0, 255}));
        assert(plugin.get("application.engine.versionMajor", version) == fray::errors::NONE && version == 9);
        assert(state.get("application.engine.versionMajor", version) == fray::errors::NONE && version == 1);
        StateManager otherCase;
        assert(otherCase.open(project, "ExamplePlugin") == fray::errors::NONE);
        assert(otherCase.set("examplePlugin.field", "other") == fray::errors::NONE);
        assert(plugin.get("examplePlugin.field", text) == fray::errors::NONE && text == "example value");
        assert(plugin.renameTable("renamed plugin") == fray::errors::NONE);
        assert(plugin.get("examplePlugin.field", text) == fray::errors::NONE && text == "example value");
        assert(plugin.renameTable("Fray") == fray::errors::FAILED_RENAME_STATE_TABLE);
        assert(plugin.close() == fray::errors::NONE);
        assert(plugin.open(project, "renamed plugin") == fray::errors::NONE);
        assert(plugin.get("examplePlugin.field", text) == fray::errors::NONE && text == "example value");
        StateManager mirror;
        assert(mirror.open(project, "renamed plugin") == fray::errors::NONE);
        assert(plugin.removeTable() == fray::errors::NONE);
        assert(plugin.get("examplePlugin.field", text) == fray::errors::STATE_NOT_FOUND);
        assert(mirror.get("examplePlugin.field", text) == fray::errors::STATE_NOT_FOUND);
        assert(mirror.remove("examplePlugin.field") == fray::errors::STATE_NOT_FOUND);
        assert(plugin.removeTable() == fray::errors::STATE_NOT_FOUND);
        assert(mirror.set("examplePlugin.field", "recreated") == fray::errors::NONE);
        assert(plugin.get("examplePlugin.field", text) == fray::errors::NONE && text == "recreated");
        assert(mirror.get("examplePlugin.field", text) == fray::errors::NONE && text == "recreated");
        assert(state.get("application.engine.versionMajor", version) == fray::errors::NONE && version == 1);

        StateManager unusual;
        assert(unusual.open(project, "x'); DROP TABLE application_state;--") == fray::errors::NONE);
        assert(unusual.set("key", "safe") == fray::errors::NONE);
        assert(unusual.get("key", text) == fray::errors::NONE && text == "safe");
        assert(state.close() == fray::errors::NONE);
    }
    {
        StateManager state;
        assert(state.open(project, "scratch") == fray::errors::NONE);
        assert(state.set("null", nullptr) == fray::errors::FAILED_SAVE_STATE);
        assert(state.set("key", 1) == fray::errors::NONE);
        assert(state.removeTable() == fray::errors::NONE);
        int value = 5;
        assert(state.get("key", value) == fray::errors::STATE_NOT_FOUND && value == 5);
        assert(state.set("key", 2) == fray::errors::NONE);
        assert(state.get("key", value) == fray::errors::NONE && value == 2);
        assert(state.close() == fray::errors::NONE);
    }

    assert(project.close() == fray::errors::NONE);
    mutateProject(argv[1], "CREATE TRIGGER reject_write BEFORE UPDATE ON fray_state_46726179 "
                           "WHEN OLD.key = 'empty-text' BEGIN SELECT RAISE(ABORT, 'blocked'); END");
    assert(project.open(argv[1]) == fray::errors::NONE);
    {
        StateManager manager;
        assert(manager.open(project) == fray::errors::NONE);
        assert(manager.set("empty-text", "changed") == fray::errors::FAILED_SAVE_STATE);
        std::string value = "unchanged";
        assert(manager.get("empty-text", value) == fray::errors::NONE && value.empty());
    }

    assert(project.close() == fray::errors::NONE);
    mutateProject(argv[1], "PRAGMA ignore_check_constraints = ON; "
                           "UPDATE fray_state_46726179 SET value = 2 WHERE key = 'bool'");
    assert(project.open(argv[1]) == fray::errors::NONE);
    {
        StateManager manager;
        assert(manager.open(project) == fray::errors::NONE);
        bool value = true;
        assert(manager.get("bool", value) == fray::errors::FAILED_LOAD_STATE);
        assert(value);
    }

    assert(project.close() == fray::errors::NONE);
    mutateProject(argv[1], "CREATE TRIGGER reject_delete BEFORE DELETE ON fray_state_46726179 "
                           "WHEN OLD.key = 'text' BEGIN SELECT RAISE(ABORT, 'blocked'); END");
    assert(project.open(argv[1]) == fray::errors::NONE);
    {
        StateManager manager;
        assert(manager.open(project) == fray::errors::NONE);
        assert(manager.remove("text") == fray::errors::FAILED_REMOVE_STATE);
        std::string text;
        assert(manager.get("text", text) == fray::errors::NONE && text == std::string("hello\0world", 11));
    }

    assert(project.close() == fray::errors::NONE);
    {
        fray::files::FileManager fixture;
        assert(fixture.open(argv[2]) == fray::errors::NONE);
    }
    mutateProject(argv[2], "CREATE TABLE fray_state_46726179 (key TEXT, value TEXT)");
    {
        fray::files::FileManager fixture;
        assert(fixture.open(argv[2]) == fray::errors::NONE);
        StateManager manager;
        assert(manager.open(fixture) == fray::errors::FAILED_OPEN_STORE);
    }
    mutateProject(argv[2], "DROP TABLE fray_state_46726179");

    for (const char* legacy : {"fray_state", "application_state", "engine_state", "ui_state", "state_values"})
    {
        const std::string table(legacy);
        mutateProject(argv[2], ("CREATE TABLE " + table + " (key TEXT, value TEXT); "
                                "INSERT INTO " + table + " VALUES ('legacy.key', 'keep')").c_str());
        {
            fray::files::FileManager fixture;
            assert(fixture.open(argv[2]) == fray::errors::NONE);
            StateManager manager;
            assert(manager.open(fixture) == fray::errors::NONE);
            std::string value = "unchanged";
            assert(manager.get("legacy.key", value) == fray::errors::STATE_NOT_FOUND && value == "unchanged");
            assert(manager.set("current", "new") == fray::errors::NONE);
        }
        const std::string database = databasePath(argv[2]);
        sqlite3* db = nullptr;
        sqlite3_stmt* statement = nullptr;
        assert(sqlite3_open(database.c_str(), &db) == SQLITE_OK);
        const std::string query = "SELECT value FROM " + table;
        assert(sqlite3_prepare_v2(db, query.c_str(), -1, &statement, nullptr) == SQLITE_OK);
        assert(sqlite3_step(statement) == SQLITE_ROW);
        assert(std::string(reinterpret_cast<const char*>(sqlite3_column_text(statement, 0))) == "keep");
        assert(sqlite3_finalize(statement) == SQLITE_OK);
        assert(sqlite3_prepare_v2(db, "SELECT count(*) FROM sqlite_master WHERE name = 'fray_state_46726179'",
                                  -1, &statement, nullptr) == SQLITE_OK);
        assert(sqlite3_step(statement) == SQLITE_ROW && sqlite3_column_int(statement, 0) == 1);
        assert(sqlite3_finalize(statement) == SQLITE_OK);
        assert(sqlite3_close(db) == SQLITE_OK);
        mutateProject(argv[2], ("DROP TABLE " + table).c_str());
    }
    mutateProject(argv[2], "CREATE VIEW application_state AS SELECT 'keep' AS value");
    {
        fray::files::FileManager fixture;
        assert(fixture.open(argv[2]) == fray::errors::NONE);
        StateManager manager;
        assert(manager.open(fixture) == fray::errors::NONE);
        std::string value;
        assert(manager.get("current", value) == fray::errors::NONE && value == "new");
    }
}
