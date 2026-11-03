/**
 * Wraps an object so that ONE call of `method` whose arguments match `when`
 * throws `error` (a crash or I/O failure at that exact point); every other call
 * goes to the real object.
 */
export function failOnce<T extends object>(
  target: T,
  method: keyof T & string,
  when: (args: unknown[]) => boolean,
  error: Error = new Error('injected failure'),
): T {
  let armed = true;
  return new Proxy(target, {
    get(obj, prop, receiver) {
      const value = Reflect.get(obj, prop, receiver) as unknown;
      if (typeof value !== 'function') return value;
      const fn = (value as (...a: unknown[]) => unknown).bind(obj);
      if (prop !== method) return fn;
      return (...args: unknown[]) => {
        if (armed && when(args)) {
          armed = false;
          return Promise.reject(error);
        }
        return fn(...args);
      };
    },
  });
}
