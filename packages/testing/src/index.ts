export function createTestLogger() {
  return {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
    child: createTestLogger,
  };
}

export function makeId(prefix: string, n: number): string {
  return `${prefix}-${n.toString().padStart(4, "0")}`;
}
