#include "../Engine/fray/log_manager.hpp"

#include <cassert>
#include <chrono>
#include <cstdio>
#include <cstring>

int main()
{
    using namespace std::chrono;
    for (int millisecondsPart : {7, 456, 999})
    {
        const auto now = system_clock::time_point(seconds(1234567893) + milliseconds(millisecondsPart));
        const std::time_t secondsPart = system_clock::to_time_t(now);
        std::tm local;
#if defined(_WIN32)
        localtime_s(&local, &secondsPart);
#else
        localtime_r(&secondsPart, &local);
#endif
        char expectedTime[32];
        char expectedTimestamp[32];
        std::snprintf(expectedTime, sizeof(expectedTime), "%02d:%02d:%02d.%03d",
            local.tm_hour, local.tm_min, local.tm_sec, millisecondsPart);
        std::snprintf(expectedTimestamp, sizeof(expectedTimestamp), "[%02d:%02d:%02d:%03d] [%02d.%02d.%02d]",
            local.tm_hour, local.tm_min, local.tm_sec, millisecondsPart,
            local.tm_year % 100, local.tm_mon + 1, local.tm_mday);
        fray::log::timeBuffer actualTime;
        fray::log::TimestampBuffer actualTimestamp;
        fray::log::getTime(actualTime, now);
        fray::log::generateTimestamp(actualTimestamp, now);
        assert(std::strcmp(actualTime, expectedTime) == 0);
        assert(std::strcmp(actualTimestamp, expectedTimestamp) == 0);
    }
}
