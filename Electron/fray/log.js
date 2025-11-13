/* log.js */

const ANSI_RESET = "\x1b[0m";
const ANSI_FG_YELLOW = "\x1b[33m";
const ANSI_FG_BLUE = "\x1b[34m";
const ANSI_BG_WHITE = "\x1b[47m";
const ANSI_BG_ORANGE = "\x1b[48;5;208m";
const ANSI_BG_RED = "\x1b[41m";
const ANSI_BG_MAGENTA = "\x1b[45m";

function getTime() {
    const now = new Date();
    const h = String(now.getHours()).padStart(2, '0');
    const m = String(now.getMinutes()).padStart(2, '0');
    const s = String(now.getSeconds()).padStart(2, '0');
    const ms = String(now.getMilliseconds()).padStart(4, '0');
    return `${h}:${m}:${s}.${ms}`;
}

function printf(PID, PIDColor, level, levelColor, message) {
    const time = getTime();
    console.log(
        `[${time}] ` +
        `[${PIDColor}${PID}${ANSI_RESET}] ` +
        `[${levelColor}${level}${ANSI_RESET}] ` +
        `${message}`
    );
}

function electronInfo(fmt, ...args) {
    printf("ELC", ANSI_FG_YELLOW, "INF", ANSI_BG_WHITE, format(fmt, ...args));
}
function electronWarn(fmt, ...args) {
    printf("ELC", ANSI_FG_YELLOW, "WRN", ANSI_BG_ORANGE, format(fmt, ...args));
}
function electronError(fmt, ...args) {
    printf("ELC", ANSI_FG_YELLOW, "ERR", ANSI_BG_RED, format(fmt, ...args));
}
function electronFatal(fmt, ...args) {
    printf("ELC", ANSI_FG_YELLOW, "FTL", ANSI_BG_MAGENTA, format(fmt, ...args));
}
function engineInfo(fmt, ...args) {
    printf("ENG", ANSI_FG_BLUE, "INF", ANSI_BG_WHITE, format(fmt, ...args));
}
function engineWarn(fmt, ...args) {
    printf("ENG", ANSI_FG_BLUE, "WRN", ANSI_BG_ORANGE, format(fmt, ...args));
}
function engineError(fmt, ...args) {
    printf("ENG", ANSI_FG_BLUE, "ERR", ANSI_BG_RED, format(fmt, ...args));
}
function engineFatal(fmt, ...args) {
    printf("ENG", ANSI_FG_BLUE, "FTL", ANSI_BG_MAGENTA, format(fmt, ...args));
}

// Simple printf-style formatting
function format(fmt, ...args) {
    let i = 0;
    return fmt.replace(/%[sdif]/g, () => args[i++]);
}

module.exports = {
    electronInfo,
    electronWarn,
    electronError,
    electronFatal,
    engineInfo,
    engineWarn,
    engineError,
    engineFatal
};