import { networkInterfaces } from "node:os";
import { openDb, getAllMessages, getMessagesSince, insertMessage, ensureChannel, createChannel, getChannels, generateId, appendToJsonl, type Message } from "./db";
import { readConfig } from "./config";

function getLocalIp(): string {
  const nets = networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const net of nets[name]!) {
      if (net.family === "IPv4" && !net.internal) return net.address;
    }
  }
  return "localhost";
}

export function startServer(chatDir: string, port: number) {
  const db = openDb(chatDir);
  const config = readConfig(chatDir);

  const server = Bun.serve({
    port,
    async fetch(req) {
      const url = new URL(req.url);
      const path = url.pathname;

      // CORS headers for flexibility
      const headers = {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
        "Content-Type": "application/json",
      };

      if (req.method === "OPTIONS") {
        return new Response(null, { headers });
      }

      // GET /api/info
      if (path === "/api/info" && req.method === "GET") {
        return Response.json({ name: config.name, owner: config.identity }, { headers });
      }

      // GET /api/channels
      if (path === "/api/channels" && req.method === "GET") {
        return Response.json({ channels: getChannels(db) }, { headers });
      }

      // POST /api/channels
      if (path === "/api/channels" && req.method === "POST") {
        const body = await req.json() as { name: string; description?: string };
        createChannel(db, body.name, body.description || "");
        return Response.json({ ok: true }, { headers });
      }

      // GET /api/sync?since=<iso>
      if (path === "/api/sync" && req.method === "GET") {
        const since = url.searchParams.get("since");
        const messages = since ? getMessagesSince(db, since) : getAllMessages(db);
        const channels = getChannels(db);
        const cursor = new Date().toISOString();
        return Response.json({ messages, channels, cursor }, { headers });
      }

      // POST /api/messages
      if (path === "/api/messages" && req.method === "POST") {
        const body = await req.json() as {
          channel: string;
          author: string;
          author_type: "human" | "agent";
          content: string;
          reply_to?: string;
          agent_context?: string;
        };

        const msg: Message = {
          id: generateId(),
          channel: body.channel,
          author: body.author,
          author_type: body.author_type || "human",
          content: body.content,
          reply_to: body.reply_to ?? null,
          agent_context: body.agent_context ?? null,
          ts: new Date().toISOString(),
        };

        ensureChannel(db, msg.channel);
        insertMessage(db, msg);
        appendToJsonl(chatDir, msg);

        return Response.json({ ok: true, message: msg }, { headers });
      }

      return Response.json({ error: "Not Found" }, { status: 404, headers });
    },
  });

  const localIp = getLocalIp();
  console.log(`Chat server started: ${config.name}`);
  console.log(`  Local:  http://localhost:${port}`);
  console.log(`  LAN:    http://${localIp}:${port}`);
  console.log("");
  console.log("Share with team:");
  console.log(`  chat join http://${localIp}:${port}`);
  console.log("");
  console.log("For internet access:");
  console.log(`  npx cloudflared tunnel --url http://localhost:${port}`);

  return server;
}
