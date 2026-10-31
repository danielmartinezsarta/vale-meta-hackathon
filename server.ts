/**
 * Single voice process (HACK-017): serves the Next app and the /voice
 * WebSocket endpoint from one process. One socket per conversation — turns
 * reset on the same socket while every turn redials Meta, which has no
 * resume. Meta credentials never leave this process.
 */
import { createServer } from "node:http";
import next from "next";
import { WebSocket, WebSocketServer } from "ws";
import { attachVoiceBridge } from "./src/lib/voice-bridge";

const port = Number(process.env.PORT ?? process.env.VOICE_PORT ?? 3000);
const app = next({ dev: false, dir: "." });
await app.prepare();
const handler = app.getRequestHandler();

const server = createServer((req, res) => {
  void handler(req, res);
});
const wss = new WebSocketServer({ noServer: true });
server.on("upgrade", (req, socket, head) => {
  const pathname = (req.url ?? "").split("?")[0];
  if (pathname !== "/voice") {
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (browser) => {
    const peer =
      (browser as unknown as { _socket?: { remoteAddress?: string } })._socket
        ?.remoteAddress ?? "unknown";
    attachVoiceBridge({
      browser: browser as never,
      key: peer,
      clientId: peer,
      conversation: true,
      createMetaSocket: (url: string) => new WebSocket(url),
    });
  });
});

server.listen(port, () => {
  console.log(`[voice-server] up on :${port} (next + /voice)`);
});
