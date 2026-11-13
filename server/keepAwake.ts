// Keeps the Mac from idle-sleeping while agents have work in flight, and lets it
// sleep again when they are done. Uses macOS's own caffeinate; closing the lid
// still sleeps the Mac (only a sudo-level power setting could prevent that).
import { spawn, type ChildProcess } from "node:child_process";

export class KeepAwake {
  private child: ChildProcess | null = null;
  readonly enabled = process.platform === "darwin" && process.env.TEAM_ROOM_KEEP_AWAKE !== "0";

  /** -i: no idle sleep; -s: no system sleep on AC power; -w: ends with this process. */
  set(busy: boolean) {
    if (!this.enabled) return;
    if (busy && !this.child) {
      this.child = spawn("caffeinate", ["-i", "-s", "-w", String(process.pid)], { stdio: "ignore" });
      this.child.on("exit", () => (this.child = null));
      this.child.on("error", () => (this.child = null));
      console.log("[awake] agents are working: keeping the Mac awake");
    } else if (!busy && this.child) {
      this.child.kill();
      this.child = null;
      console.log("[awake] agents are idle: the Mac may sleep again");
    }
  }

  get active() {
    return !!this.child;
  }
}
