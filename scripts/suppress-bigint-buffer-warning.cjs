const BIGINT_BUFFER_WARNING =
  "bigint: Failed to load bindings, pure JS will be used (try npm run rebuild?)";

const originalWarn = console.warn.bind(console);

console.warn = (...args) => {
  if (args.length === 1 && args[0] === BIGINT_BUFFER_WARNING) {
    return;
  }

  originalWarn(...args);
};
