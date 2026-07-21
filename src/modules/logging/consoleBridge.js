/**
 * Makes renderer logs readable in the terminal.
 *
 * Electron's console-message event delivers an already-formatted string, so
 * any object logged from the renderer arrives as "[object Object]". That makes
 * every diagnostic log useless unless DevTools happens to be open, which is
 * exactly when you need them most.
 *
 * Objects are serialised at the source instead. Typed arrays are summarised
 * rather than dumped, since audio buffers hold thousands of samples.
 */

function format(value) {
  if (value === null || typeof value !== 'object') {
    return value;
  }

  if (value instanceof Error) {
    return value.stack || `${value.name}: ${value.message}`;
  }

  if (ArrayBuffer.isView(value)) {
    return `${value.constructor.name}(${value.length})`;
  }

  try {
    return JSON.stringify(value, (_key, nested) =>
      ArrayBuffer.isView(nested)
        ? `${nested.constructor.name}(${nested.length})`
        : nested
    );
  } catch {
    return String(value);
  }
}

for (const level of ['log', 'info', 'warn', 'error', 'debug']) {
  const original = console[level].bind(console);
  console[level] = (...args) => original(...args.map(format));
}
