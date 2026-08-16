export function log(level: "info" | "warn" | "error", msg: string, ...rest: unknown[]): void {
  const ts = new Date().toISOString();
  const fn = level === "error" ? console.error : level === "warn" ? console.warn : console.log;
  fn(`[${ts}] [${level.toUpperCase()}] ${msg}`, ...rest);
}