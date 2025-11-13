/* log.hpp */

#ifndef _FRAY_LOG_HPP_
#define _FRAY_LOG_HPP_

#include <cstdio>
#include <ctime>
#include <chrono>
#include <string>
#include <cstdarg>

#include "types.hpp"
#include "errors.hpp"

namespace fray
{
    namespace log
    {
        // Text Styles
        constexpr const F_char *ANSI_RESET = "\033[0m";
        constexpr const F_char *ANSI_BOLD = "\033[1m";
        constexpr const F_char *ANSI_UNDERLINE = "\033[4m";
        constexpr const F_char *ANSI_BLINK = "\033[5m";
        constexpr const F_char *ANSI_INVERSE = "\033[7m";

        // Foreground Colors
        constexpr const F_char *ANSI_FG_BLACK = "\033[30m";
        constexpr const F_char *ANSI_FG_RED = "\033[31m";
        constexpr const F_char *ANSI_FG_GREEN = "\033[32m";
        constexpr const F_char *ANSI_FG_YELLOW = "\033[33m";
        constexpr const F_char *ANSI_FG_BLUE = "\033[34m";
        constexpr const F_char *ANSI_FG_MAGENTA = "\033[35m";
        constexpr const F_char *ANSI_FG_CYAN = "\033[36m";
        constexpr const F_char *ANSI_FG_WHITE = "\033[37m";
        constexpr const F_char *ANSI_FG_ORANGE = "\x1b[38;5;208m";

        // Background Colors
        constexpr const F_char *ANSI_BG_BLACK = "\033[40m";
        constexpr const F_char *ANSI_BG_RED = "\033[41m";
        constexpr const F_char *ANSI_BG_GREEN = "\033[42m";
        constexpr const F_char *ANSI_BG_YELLOW = "\033[43m";
        constexpr const F_char *ANSI_BG_BLUE = "\033[44m";
        constexpr const F_char *ANSI_BG_MAGENTA = "\033[45m";
        constexpr const F_char *ANSI_BG_CYAN = "\033[46m";
        constexpr const F_char *ANSI_BG_WHITE = "\033[47m";
        constexpr const F_char *ANSI_BG_ORANGE = "\033[48;5;208m";

        constexpr F_long TIMESTAMP_SIZE = 32;
        using TimestampBuffer = F_char[TIMESTAMP_SIZE];
        constexpr F_long DATE_SIZE = 32;
        using dateBuffer = F_char[DATE_SIZE];
        constexpr F_long TIME_SIZE = 32;
        using timeBuffer = F_char[TIME_SIZE];

        inline F_void generateTimestamp(F_char *timestamp)
        {
            using namespace std::chrono;
            auto now = system_clock::now();
            auto ms = duration_cast<milliseconds>(now.time_since_epoch()) % 10000;

            std::time_t t = system_clock::to_time_t(now);
            std::tm tm;
#if defined(_WIN32)
            localtime_s(&tm, &t);
#else
            localtime_r(&t, &tm);
#endif

            std::snprintf(
                timestamp, 32, "[%02d:%02d:%02d:%04d] [%02d.%02d.%02d]",
                tm.tm_hour, tm.tm_min, tm.tm_sec,
                static_cast<F_long>(ms.count()),
                tm.tm_year % 100, tm.tm_mon + 1, tm.tm_mday);
        }

        inline F_void getDate(F_char *date)
        {
            using namespace std::chrono;
            auto now = system_clock::now();
            std::time_t t = system_clock::to_time_t(now);
            std::tm tm;
#if defined(_WIN32)
            localtime_s(&tm, &t);
#else
            localtime_r(&t, &tm);
#endif

            std::snprintf(
                date, 32, "%02d.%02d.%02d",
                tm.tm_year % 100, tm.tm_mon + 1, tm.tm_mday);
        }

        inline F_void getTime(F_char *time)
        {
            using namespace std::chrono;
            auto now = system_clock::now();
            auto ms = duration_cast<milliseconds>(now.time_since_epoch()) % 10000;

            std::time_t t = system_clock::to_time_t(now);
            std::tm tm;
#if defined(_WIN32)
            localtime_s(&tm, &t);
#else
            localtime_r(&t, &tm);
#endif

            std::snprintf(
                time, 32, "%02d:%02d:%02d.%04d",
                tm.tm_hour, tm.tm_min, tm.tm_sec,
                static_cast<int>(ms.count()));
        }

        inline F_void printf(
            const F_char *PID,
            const F_char *PIDColor,
            const F_char *level,
            const F_char *levelColor,
            const F_char *message)
        {
            timeBuffer tb;
            getTime(tb);

            std::printf("[%s] ", tb);
            std::printf("[%s%s%s] ", PIDColor, PID, ANSI_RESET);
            std::printf("[%s%s%s] ", levelColor, level, ANSI_RESET);
            std::printf("%s\n", message);
            std::fflush(stdout);
        }

        inline F_void vprintf_helper(
            const F_char *PID,
            const F_char *PIDColor,
            const F_char *level,
            const F_char *levelColor,
            const F_char *fmt,
            va_list args)
        {
            char message[1024];
            std::vsnprintf(message, sizeof(message), fmt, args);
            printf(PID, PIDColor, level, levelColor, message);
        }

        inline F_void electronInfo(const F_char *fmt, ...)
        {
            va_list args;
            va_start(args, fmt);
            vprintf_helper("ELC", ANSI_FG_YELLOW, "INF", ANSI_BG_WHITE, fmt, args);
            va_end(args);
        }

        inline F_void electronWarn(const F_char *fmt, ...)
        {
            va_list args;
            va_start(args, fmt);
            vprintf_helper("ELC", ANSI_FG_YELLOW, "WRN", ANSI_BG_ORANGE, fmt, args);
            va_end(args);
        }

        inline F_void electronError(const F_char *fmt, ...)
        {
            va_list args;
            va_start(args, fmt);
            vprintf_helper("ELC", ANSI_FG_YELLOW, "ERR", ANSI_BG_RED, fmt, args);
            va_end(args);
        }

        inline F_void electronFatal(const F_char *fmt, ...)
        {
            va_list args;
            va_start(args, fmt);
            vprintf_helper("ELC", ANSI_FG_YELLOW, "FTL", ANSI_BG_MAGENTA, fmt, args);
            va_end(args);
        }

        inline F_void engineInfo(const F_char *fmt, ...)
        {
            va_list args;
            va_start(args, fmt);
            vprintf_helper("ENG", ANSI_FG_BLUE, "INF", ANSI_BG_WHITE, fmt, args);
            va_end(args);
        }

        inline F_void engineWarn(const F_char *fmt, ...)
        {
            va_list args;
            va_start(args, fmt);
            vprintf_helper("ENG", ANSI_FG_BLUE, "WRN", ANSI_BG_ORANGE, fmt, args);
            va_end(args);
        }

        inline F_void engineError(const F_char *fmt, ...)
        {
            va_list args;
            va_start(args, fmt);
            vprintf_helper("ENG", ANSI_FG_BLUE, "ERR", ANSI_BG_RED, fmt, args);
            va_end(args);
        }

        inline F_void engineFatal(const F_char *fmt, ...)
        {
            va_list args;
            va_start(args, fmt);
            vprintf_helper("ENG", ANSI_FG_BLUE, "FTL", ANSI_BG_MAGENTA, fmt, args);
            va_end(args);
        }
    }
}

#define ERR(func)                                                    \
    do                                                               \
    {                                                                \
        F_err _err = (func);                                         \
        if (_err != fray::errors::NONE)                              \
        {                                                            \
            fray::log::engineError(fray::errors::description(_err)); \
            return _err;                                             \
        }                                                            \
    } while (0)

#endif