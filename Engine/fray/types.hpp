#ifndef _FRAY_TYPES_HPP_
#define _FRAY_TYPES_HPP_

#include <cstdint>

// Platform detection
#if defined(_WIN32) || defined(_WIN64)
    #define FRAY_WINDOWS
#elif defined(__APPLE__) || defined(__MACH__)
    #define FRAY_MAC
#elif defined(__linux__)
    #define FRAY_LINUX
#else
    #define FRAY_UNKNOWN_OS
#endif

// Basic types
typedef void            F_void;
typedef char            F_char;
typedef unsigned char   F_uchar;
typedef int16_t         F_short;
typedef uint16_t        F_ushort;
typedef int32_t         F_long;
typedef uint32_t        F_ulong;
typedef float           F_float;
typedef int64_t         F_longlong;
typedef uint64_t        F_ulonglong;
typedef double          F_double;

// String types
#ifdef FRAY_WINDOWS
    typedef wchar_t     F_wchar;
    typedef wchar_t*    F_wstring;
#else
    typedef char        F_wchar;
    typedef char*       F_wstring;
#endif

#endif