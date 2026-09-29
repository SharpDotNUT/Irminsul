let silent = false;
let sink: ((text: string) => void) | null = null;

export function setSilent(value: boolean): void {
  silent = value;
}

/** 把每一行输出同时交给运行日志（见 `timing.ts`）；与 `--silent` 无关，压的只是终端。 */
export function setLogSink(value: ((text: string) => void) | null): void {
  sink = value;
}

export function log(message: string): void {
  if (!silent) console.log(message);
  sink?.(message);
}

export function warn(message: string): void {
  const text = `warning: ${message}`;
  console.error(text);
  sink?.(text);
}
