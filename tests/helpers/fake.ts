// Test doubles implement only the members a test exercises. Checking them against
// this shape keeps member names and data fields aligned with the host type while
// leaving function signatures to the test. Callable members may be faked either as
// a function or by the properties they carry.
export type Fake<T> = T extends (...args: never[]) => unknown
  ? ((...args: never[]) => unknown) | { [K in keyof T]?: Fake<T[K]> }
  : T extends object
    ? { [K in keyof T]?: Fake<T[K]> }
    : T
