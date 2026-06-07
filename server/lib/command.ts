import { spawn } from "node:child_process";

export function commandAvailable(command: string, args: string[], timeoutMs = 5_000): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (available: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(available);
    };
    const child = spawn(command, args, { windowsHide: true });
    const timer = setTimeout(() => {
      child.kill();
      finish(false);
    }, timeoutMs);
    timer.unref?.();
    child.on("error", () => finish(false));
    child.on("close", (code) => finish(code === 0));
  });
}
