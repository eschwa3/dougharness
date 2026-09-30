import { Server } from "node:net";

export const LISTEN_DENIED =
  "listening on 127.0.0.1 failed with EPERM: this sandbox denies local listeners, so the doug board serve tests cannot run here";

export function localListenerDenied(): Promise<string> {
  return new Promise((resolve) => {
    const server = new Server();
    server.once("error", (err: NodeJS.ErrnoException) => {
      resolve(err.code === "EPERM" ? LISTEN_DENIED : "");
    });
    server.once("listening", () => {
      server.close(() => resolve(""));
    });
    server.listen(0, "127.0.0.1");
  });
}
