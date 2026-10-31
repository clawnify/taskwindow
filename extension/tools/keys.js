/**
 * The physical key a printable character comes from on a US keyboard.
 *
 * A key event's windowsVirtualKeyCode names the key, not the character, and
 * only letters and digits share a number with their ASCII code. Punctuation
 * does not: "." is 46, which is VK_DELETE, and "#" is 35, which is VK_END, so
 * sending charCodeAt as the key code makes Chrome edit instead of insert.
 */

// [code, vk] for each key, then the character it types unshifted and shifted.
const KEYS = [
  ["Backquote", 192, "`", "~"],
  ["Digit1", 49, "1", "!"],
  ["Digit2", 50, "2", "@"],
  ["Digit3", 51, "3", "#"],
  ["Digit4", 52, "4", "$"],
  ["Digit5", 53, "5", "%"],
  ["Digit6", 54, "6", "^"],
  ["Digit7", 55, "7", "&"],
  ["Digit8", 56, "8", "*"],
  ["Digit9", 57, "9", "("],
  ["Digit0", 48, "0", ")"],
  ["Minus", 189, "-", "_"],
  ["Equal", 187, "=", "+"],
  ["BracketLeft", 219, "[", "{"],
  ["BracketRight", 221, "]", "}"],
  ["Backslash", 220, "\\", "|"],
  ["Semicolon", 186, ";", ":"],
  ["Quote", 222, "'", '"'],
  ["Comma", 188, ",", "<"],
  ["Period", 190, ".", ">"],
  ["Slash", 191, "/", "?"],
  ["Space", 32, " ", null],
];

const BY_CHAR = new Map();
for (const [code, vk, plain, shifted] of KEYS) {
  BY_CHAR.set(plain, { code, vk, shift: false });
  if (shifted) BY_CHAR.set(shifted, { code, vk, shift: true });
}
for (let c = 65; c <= 90; c++) {
  const upper = String.fromCharCode(c);
  BY_CHAR.set(upper.toLowerCase(), { code: "Key" + upper, vk: c, shift: false });
  BY_CHAR.set(upper, { code: "Key" + upper, vk: c, shift: true });
}

/** The unshifted character of a key named by its code ("Period" → "."), or undefined. */
export function charOfCode(code) {
  for (const [ch, k] of BY_CHAR) if (k.code === code && !k.shift) return ch;
}

/**
 * { code, vk, shift } for a character a US keyboard types, or, for anything
 * else (accents, other scripts, emoji), no key at all: vk 0 and an empty code,
 * which Chrome inserts from the event's text without treating it as a command.
 */
export function usKey(ch) {
  return BY_CHAR.get(ch) ?? { code: "", vk: 0, shift: false };
}

/**
 * macOS editing shortcuts, as the commands Chrome runs for them.
 *
 * On a Mac the renderer does not act on Cmd+A, Cmd+Z, Cmd+Backspace and the
 * like: Chrome's Edit menu and the Cocoa key bindings turn them into editing
 * commands in the browser, for the focused window only. A CDP key event never
 * reaches the key bindings, and reaches the menu only while its tab's window
 * is focused, which the agent window never is. So they arrived as bare
 * keydowns that edited nothing, and "select all, then type" appended (#41).
 * Input.dispatchKeyEvent takes the commands to run with the key. These are the
 * macOS bindings (the table Playwright sends too), less the plain, Shift and
 * Alt keys, which the renderer handles itself.
 *
 * Copy, cut and paste are left out on purpose: they would read and overwrite
 * the user's own clipboard while they work in other windows, and an agent
 * reads page text and types it without one.
 */
const MAC_COMMANDS = {
  "Meta+KeyA": "selectAll",
  "Meta+KeyZ": "undo",
  "Shift+Meta+KeyZ": "redo",
  "Meta+Backspace": "deleteToBeginningOfLine",
  "Shift+Meta+Backspace": "deleteToBeginningOfLine",
  "Meta+ArrowUp": "moveToBeginningOfDocument",
  "Meta+ArrowDown": "moveToEndOfDocument",
  "Meta+ArrowLeft": "moveToLeftEndOfLine",
  "Meta+ArrowRight": "moveToRightEndOfLine",
  "Shift+Meta+ArrowUp": "moveToBeginningOfDocumentAndModifySelection",
  "Shift+Meta+ArrowDown": "moveToEndOfDocumentAndModifySelection",
  "Shift+Meta+ArrowLeft": "moveToLeftEndOfLineAndModifySelection",
  "Shift+Meta+ArrowRight": "moveToRightEndOfLineAndModifySelection",
};

// Agents send Ctrl+A for select all whatever the OS. On a Mac that key edits
// nothing over CDP (its own binding moves to the line start, and only through
// the Cocoa bindings above), so it gets what the agent meant: Cmd+A's command.
// The same goes for Ctrl+Z and Ctrl+Shift+Z.
const CONTROL_AS_META = new Set(["KeyA", "KeyZ"]);

/**
 * The editing commands a key press runs on macOS, or undefined. `modifiers`
 * is CDP's bitmask: Alt 1, Control 2, Meta 4, Shift 8.
 */
export function macCommands(code, modifiers) {
  let mods = modifiers;
  if ((mods & 7) === 2 && CONTROL_AS_META.has(code)) mods = (mods & ~2) | 4;
  const name = [[8, "Shift"], [2, "Control"], [1, "Alt"], [4, "Meta"]]
    .filter(([bit]) => mods & bit)
    .map(([, label]) => label)
    .concat(code)
    .join("+");
  const command = MAC_COMMANDS[name];
  return command ? [command] : undefined;
}
