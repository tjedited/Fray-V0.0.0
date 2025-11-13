/* error.hpp */

#ifndef _FRAY_ERRORS_HPP_
#define _FRAY_ERRORS_HPP_

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
    X(FAILED_START, "Failed to start the engine process.")

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
        std::snprintf(buffer, sizeof(buffer), "Error %lld: %s", static_cast<F_longlong>(code::name), desc); \
        return buffer;
                FRAY_ERROR_LIST
#undef X
            default:
                std::snprintf(buffer, sizeof(buffer), "Error %lld: %s", static_cast<F_longlong>(err), "Unknown error.");
                return buffer;
            }
        }

        inline const F_char *description(F_err err)
        {
            return description(static_cast<code>(err));
        }

    } // namespace errors
} // namespace fray

#endif