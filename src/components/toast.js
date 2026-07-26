let _id = 0;
const _subs = new Set();

function add(level, text, duration) {
  const item = { id: ++_id, level, text, duration };
  _subs.forEach(fn => fn(item));
}

export const toast = {
  ok:         (text) => add("ok",    text, 3000),
  warn:       (text) => add("warn",  text, 4500),
  error:      (text) => add("error", text, 6000),
  _subscribe: (fn)   => { _subs.add(fn); return () => _subs.delete(fn); },
};
