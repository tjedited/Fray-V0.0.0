/* log_manager.js */

const ANSI_RESET = "\x1b[0m";
const ANSI_FG_YELLOW = "\x1b[33m";
const ANSI_FG_BLUE = "\x1b[34m";
const ANSI_BG_WHITE = "\x1b[47m";
const ANSI_BG_ORANGE = "\x1b[48;5;208m";
const ANSI_BG_RED = "\x1b[41m";
const ANSI_BG_MAGENTA = "\x1b[45m";

/**
 * Get the current time formatted as HH:MM:SS.mmm.
 * @returns {string} The formatted time.
 */
function getTime() {
    const now = new Date();
    const h = String(now.getHours()).padStart(2, '0');
    const m = String(now.getMinutes()).padStart(2, '0');
    const s = String(now.getSeconds()).padStart(2, '0');
    const ms = String(now.getMilliseconds()).padStart(3, '0');
    return `${h}:${m}:${s}.${ms}`;
}

/**
 * Print a formatted log line with PID, level, and colors.
 * @param {string} PID Process identifier (e.g., "ENG", "ELC").
 * @param {string} PIDColor ANSI color code for the PID label.
 * @param {string} level Log level label (e.g., "INF", "WRN").
 * @param {string} levelColor ANSI color code for the level block.
 * @param {string} message The formatted message string.
 * @returns {void}
 */
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

/**
 * Simple printf-style formatter supporting %s, %d, %i, %f tokens.
 * Tokens are replaced left-to-right by provided args.
 * @param {string} fmt Format string containing tokens.
 * @param {...any} args Values to insert into tokens.
 * @returns {string} The formatted string.
 */
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