/* error.hpp */

#ifndef _FRAY_ERRORS_HPP_
#define _FRAY_ERRORS_HPP_

#include <cstdio>

#include "types.hpp"

typedef F_long F_err;

namespace fray
{
    namespace errors
    {

// Define all errors in one macro list
#define FRAY_ERROR_LIST          \
    X(NONE, "No error.")         \
    X(FLAG_1, "Flag 1 error.")   \
    X(FLAG_2, "Flag 2 error.")   \
    X(FLAG_3, "Flag 3 error.")   \
    X(FLAG_4, "Flag 4 error.")   \
    X(FLAG_5, "Flag 5 error.")   \
    X(FLAG_6, "Flag 6 error.")   \
    X(FLAG_7, "Flag 7 error.")   \
    X(FLAG_8, "Flag 8 error.")   \
    X(FLAG_9, "Flag 9 error.")   \
    X(GENERAL, "General error.") \
    X(FAILED_SET_STATE, "Failed to update the state.") \
    X(INVALID_APPLICATION_ID, "Could not set the state application ID.") \
    X(NO_MESSAGE_ROUTER, "The TCP server's message router has not been set.") \
    X(FAILED_START, "Failed to start the engine process.") \
    X(FAILED_OPEN_STORE, "Failed to open the store.") \
    X(FAILED_SAVE_STATE, "Failed to save the state.") \
    X(FAILED_LOAD_STATE, "Failed to load the state.") \
    X(STATE_NOT_FOUND, "State key does not exist.") \
    X(INVALID_STATE_KEY, "The state key is invalid.") \
    X(STATE_TYPE_MISMATCH, "The state value has a different type.") \
    X(STATE_VALUE_OUT_OF_RANGE, "The state value is outside the supported range.") \
    X(FAILED_REMOVE_STATE, "Failed to remove state.") \
    X(FAILED_CLOSE_STORE, "Failed to close the store.") \
    X(FAILED_RENAME_STATE_TABLE, "Failed to rename the state table.") \
    X(FAILED_OPEN_PROJECT, "Failed to open the project.") \
    X(FAILED_SAVE_PROJECT, "Failed to save the project.") \
    X(FAILED_CLOSE_PROJECT, "Failed to close the project.") \
    X(PROJECT_CONFLICT, "Both the project archive and working folder exist.") \
    X(PROJECT_ALREADY_OPEN, "A project with this name is already open.") \
    X(DATABASE_CONFLICT, "Multiple database files could be the project database.") \
    X(FAILED_RENAME_PROJECT, "Failed to rename the project.") \
    X(FAILED_SPAWN_PROCESS, "Failed to spawn the process.") \
    X(INVALID_MESSAGE, "The message is malformed.") \
    X(MESSAGE_TOO_LARGE, "The message exceeds the maximum frame size.") \
    X(UNSUPPORTED_MESSAGE_VERSION, "The message prefix version is not supported.")

        enum code : F_err
        {
#define X(name, desc) name,
            FRAY_ERROR_LIST
#undef X
        };

        inline const F_char *description(code err)
        {
            static F_char buffer[128];
            switch (err)
            {
#define X(name, desc)                                                                                      \
    case code::name:                                                                                       \
        snprintf(buffer, sizeof(buffer), "Error %lld: %s", static_cast<F_longlong>(code::name), desc); \
        return buffer;
                FRAY_ERROR_LIST
#undef X
            default:
                snprintf(buffer, sizeof(buffer), "Error %lld: %s", static_cast<F_longlong>(err), "Unknown error.");
                return buffer;
            }
        }

        inline const F_char *description(F_err err)
        {
            return description(static_cast<code>(err));
        }

    }
}

#endif