/* log.cpp */

#include "log.hpp"

F_void fray::log::generateTimestamp(F_char *timestamp)
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

F_void fray::log::getDate(F_char *date)
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
        date, 32, "%02d.%02d.%02d",
        tm.tm_year % 100, tm.tm_mon + 1, tm.tm_mday);
}

F_void fray::log::getTime(F_char *time)
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

F_void fray::log::printf(
    const F_char* PID,
    const F_char* PIDColor,
    const F_char* level,
    const F_char* levelColor,
    const F_char* message
    )
{
    fray::log::timeBuffer tb;
    fray::log::getTime(tb);

    std::printf("[%s] ", tb);
    std::printf("[%s%s%s] ", PIDColor, PID, ANSI_RESET);
    std::printf("[%s%s%s] ", levelColor, level, ANSI_RESET);
    std::printf("%s\n", message);
}

F_void fray::log::electronInfo(const F_char *message)
{
    fray::log::printf("ELC", ANSI_FG_YELLOW, "INF", ANSI_BG_WHITE, message);
}

F_void fray::log::electronWarn(const F_char *message)
{
    fray::log::printf("ELC", ANSI_FG_YELLOW, "WRN", ANSI_BG_ORANGE, message);
}

F_void fray::log::electronError(const F_char *message)
{
    fray::log::printf("ELC", ANSI_FG_YELLOW, "ERR", ANSI_BG_RED, message);
}

F_void fray::log::electronFatal(const F_char *message)
{
    fray::log::printf("ELC", ANSI_FG_YELLOW, "FTL", ANSI_BG_MAGENTA, message);
}

F_void fray::log::engineInfo(const F_char *message)
{
    fray::log::printf("ENG", ANSI_FG_BLUE, "INF", ANSI_BG_WHITE, message);
}

F_void fray::log::engineWarn(const F_char *message)
{
    fray::log::printf("ENG", ANSI_FG_BLUE, "WRN", ANSI_BG_ORANGE, message);
}

F_void fray::log::engineError(const F_char *message)
{
    fray::log::printf("ENG", ANSI_FG_BLUE, "ERR", ANSI_BG_RED, message);
}

F_void fray::log::engineFatal(const F_char *message)
{
    fray::log::printf("ENG", ANSI_FG_BLUE, "FTL", ANSI_BG_MAGENTA, message);
}