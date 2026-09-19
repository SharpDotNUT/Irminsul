let silent = false;

export function setSilent(value: boolean): void {
  silent = value;
}

export function log(message: string): void {
  if (!silent) console.log(message);
}

export function warn(message: string): void {
  console.error(`warning: ${message}`);
}
