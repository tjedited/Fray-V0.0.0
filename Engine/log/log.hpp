/* log.hpp */

#ifndef _FRAY_LOG_HPP_
#define _FRAY_LOG_HPP_

#include <cstdio>
#include <ctime>
#include <chrono>
#include <string>

#include "../fray/fray.hpp"

namespace fray::log
{
// Text Styles
    constexpr const F_char* ANSI_RESET = "\033[0m";
    constexpr const F_char* ANSI_BOLD = "\033[1m";
    constexpr const F_char* ANSI_UNDERLINE = "\033[4m";
    constexpr const F_char* ANSI_BLINK = "\033[5m";
    constexpr const F_char* ANSI_INVERSE = "\033[7m";

    // Foreground Colors
    constexpr const F_char* ANSI_FG_BLACK = "\033[30m";
    constexpr const F_char* ANSI_FG_RED = "\033[31m";
    constexpr const F_char* ANSI_FG_GREEN = "\033[32m";
    constexpr const F_char* ANSI_FG_YELLOW = "\033[33m";
    constexpr const F_char* ANSI_FG_BLUE = "\033[34m";
    constexpr const F_char* ANSI_FG_MAGENTA = "\033[35m";
    constexpr const F_char* ANSI_FG_CYAN = "\033[36m";
    constexpr const F_char* ANSI_FG_WHITE = "\033[37m";
    constexpr const F_char* ANSI_FG_ORANGE = "\x1b[38;5;208m";
    

    // Background Colors
    constexpr const F_char* ANSI_BG_BLACK = "\033[40m";
    constexpr const F_char* ANSI_BG_RED = "\033[41m";
    constexpr const F_char* ANSI_BG_GREEN = "\033[42m";
    constexpr const F_char* ANSI_BG_YELLOW = "\033[43m";
    constexpr const F_char* ANSI_BG_BLUE = "\033[44m";
    constexpr const F_char* ANSI_BG_MAGENTA = "\033[45m";
    constexpr const F_char* ANSI_BG_CYAN = "\033[46m";
    constexpr const F_char* ANSI_BG_WHITE = "\033[47m";
    constexpr const F_char* ANSI_BG_ORANGE = "\033[48;5;208m";

    constexpr F_long TIMESTAMP_SIZE = 32;
    using TimestampBuffer = F_char[TIMESTAMP_SIZE];
    F_void generateTimestamp(F_char *timestamp);

    constexpr F_long DATE_SIZE = 32;
    using dateBuffer = F_char[DATE_SIZE];
    F_void getDate(F_char *date);
    constexpr F_long TIME_SIZE = 32;
    using timeBuffer = F_char[TIME_SIZE];
    F_void getTime(F_char *time);

    F_void printf(
        const F_char* PID,
        const F_char* PIDColor,
        const F_char* level,
        const F_char* levelColor,
        const F_char* message);

    F_void electronInfo(const F_char *message);
    F_void electronWarn(const F_char *message);
    F_void electronError(const F_char *message);
    F_void electronFatal(const F_char *message);
    F_void engineInfo(const F_char *message);
    F_void engineWarn(const F_char *message);
    F_void engineError(const F_char *message);
    F_void engineFatal(const F_char *message);
}

#endif