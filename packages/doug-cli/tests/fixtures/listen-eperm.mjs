// Preload loaded only via NODE_OPTIONS=--import=<file url> by board-page-skip.test.ts.
// It simulates the Codex sandbox's EPERM on a local net listener; do not import it directly.
import { Server } from "node:net";

Server.prototype.listen = function listen() {
  const server = this;
  process.nextTick(() => {
    const err = new Error("listen EPERM: operation not permitted 127.0.0.1");
    err.code = "EPERM";
    err.syscall = "listen";
    err.address = "127.0.0.1";
    server.emit("error", err);
  });
  return this;
};
