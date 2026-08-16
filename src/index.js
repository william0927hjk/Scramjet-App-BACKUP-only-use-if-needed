import { createServer } from "node:http";
import { fileURLToPath } from "url";
import { hostname } from "node:os";
import { server as wisp, logging } from "@mercuryworkshop/wisp-js/server";
import Fastify from "fastify";
import fastifyStatic from "@fastify/static";
import { WebSocketServer } from "ws";
import { readFileSync } from "node:fs";

import { scramjetPath } from "@mercuryworkshop/scramjet/path";
import { libcurlPath } from "@mercuryworkshop/libcurl-transport";
import { baremuxPath } from "@mercuryworkshop/bare-mux/node";

const publicPath = fileURLToPath(new URL("../public/", import.meta.url));


try {
	const env = readFileSync(process.cwd() + "/.env", "utf8");
	for (const line of env.split("\n")) {
		const [key, ...rest] = line.split("=");
		if (key && rest.length) process.env[key.trim()] = rest.join("=").trim();
	}
} catch { /* no .env file, use existing env */ }


logging.set_level(logging.NONE);
Object.assign(wisp.options, {
	allow_udp_streams: false,
	hostname_blacklist: [/example\.com/],
	dns_servers: ["1.1.1.3", "1.0.0.3"],
});


const BAD_WORDS = [
	"fuck", "shit", "ass", "bitch", "cunt", "dick", "pussy", "cock",
	"nigger", "nigga", "faggot", "retard", "whore", "slut", "bastard",
	"piss", "crap", "asshole", "motherfucker", "fucker",
];

function filterText(text) {
	let filtered = text;
	for (const word of BAD_WORDS) {
		const regex = new RegExp(`\\b${word}\\b`, "gi");
		filtered = filtered.replace(regex, "*".repeat(word.length));
	}
	return filtered;
}


const chatClients = new Map(); 
const chatHistory = [];
const MAX_HISTORY = 50;

const chatWss = new WebSocketServer({ noServer: true });

function broadcastOnline() {
	const count = chatClients.size;
	const out = JSON.stringify({ type: "online", count });
	for (const [client] of chatClients) {
		if (client.readyState === 1) client.send(out);
	}
}

function broadcast(msg) {
	const out = JSON.stringify(msg);
	for (const [client] of chatClients) {
		if (client.readyState === 1) client.send(out);
	}
}

function broadcastSystem(text) {
	const msg = { type: "system", text, time: Date.now() };
	chatHistory.push(msg);
	if (chatHistory.length > MAX_HISTORY) chatHistory.shift();
	broadcast(msg);
}

chatWss.on("connection", (ws) => {
	let username = "Anonymous";
	chatClients.set(ws, { username });

	
	if (chatHistory.length) {
		ws.send(JSON.stringify({ type: "history", messages: chatHistory }));
	}

	// Send current online count to everyone
	broadcastOnline();

	ws.on("message", (raw) => {
		let data;
		try { data = JSON.parse(raw); } catch { return; }

		if (data.type === "join") {
			const newName = String(data.username || "Anonymous").slice(0, 20).trim() || "Anonymous";
			username = newName;
			chatClients.set(ws, { username });
			broadcastSystem(`${username} joined the chat`);
			broadcastOnline();
		} else if (data.type === "message") {
			const rawText = String(data.text || "").slice(0, 300);
			const filteredText = filterText(rawText);
			username = String(data.username || "Anonymous").slice(0, 20).trim() || "Anonymous";
			chatClients.set(ws, { username });

			if (!filteredText.trim()) return;

			const msg = {
				type: "message",
				username,
				text: filteredText,
				time: Date.now(),
			};

			chatHistory.push(msg);
			if (chatHistory.length > MAX_HISTORY) chatHistory.shift();
			broadcast(msg);
		}
	});

	ws.on("close", () => {
		const info = chatClients.get(ws);
		chatClients.delete(ws);
		if (info && info.username !== "Anonymous") {
			broadcastSystem(`${info.username} left the chat`);
		}
		broadcastOnline();
	});

	ws.on("error", () => {
		chatClients.delete(ws);
		broadcastOnline();
	});
});

const fastify = Fastify({
	serverFactory: (handler) => {
		return createServer()
			.on("request", (req, res) => {
				res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
				// Use credentialless instead of require-corp so external images load
				// Only scramjet/baremux/libcurl need the stricter require-corp
				const needsStrictCOEP = req.url.startsWith("/scram/") || req.url.startsWith("/baremux/") || req.url.startsWith("/libcurl/");
				res.setHeader("Cross-Origin-Embedder-Policy", needsStrictCOEP ? "require-corp" : "credentialless");
				handler(req, res);
			})
			.on("upgrade", (req, socket, head) => {
				if (req.url.endsWith("/wisp/")) {
					wisp.routeRequest(req, socket, head);
				} else if (req.url === "/chat/") {
					chatWss.handleUpgrade(req, socket, head, (ws) => {
						chatWss.emit("connection", ws, req);
					});
				} else {
					socket.end();
				}
			});
	},
});

fastify.register(fastifyStatic, { root: publicPath, decorateReply: true });
fastify.register(fastifyStatic, { root: scramjetPath, prefix: "/scram/", decorateReply: false });
fastify.register(fastifyStatic, { root: libcurlPath, prefix: "/libcurl/", decorateReply: false });
fastify.register(fastifyStatic, { root: baremuxPath, prefix: "/baremux/", decorateReply: false });

// â”€â”€ AI PROXY ENDPOINT â”€â”€
fastify.post("/ai", async (req, reply) => {
	const key = process.env.GROQ_KEY;
	if (!key) {
		return reply.code(500).send({ error: "No API key configured" });
	}
	try {
		const { messages, system } = req.body;
		const groqMessages = system
			? [{ role: "system", content: system }, ...messages]
			: messages;

		const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				"Authorization": `Bearer ${key}`,
			},
			body: JSON.stringify({
				model: "llama-3.1-8b-instant",
				max_tokens: 1000,
				messages: groqMessages,
			}),
		});
		const data = await response.json();
		console.log("Groq response:", JSON.stringify(data));
		// Return in Anthropic-compatible format so frontend doesn't need changes
		const text = data.choices?.[0]?.message?.content || "Sorry, something went wrong.";
		return reply.send({ content: [{ type: "text", text }] });
	} catch (err) {
		return reply.code(500).send({ error: err.message });
	}
});

fastify.setNotFoundHandler((req, reply) => {
	const isAsset = /\.(js|css|png|webp|ico|wasm|map|json|html|txt|svg)(\?.*)?$/.test(req.url);
	if (isAsset) return reply.code(404).type("text/html").sendFile("404.html");
	return reply.sendFile("index.html");
});

fastify.server.on("listening", () => {
	const address = fastify.server.address();
	console.log("Listening on:");
	console.log(`\thttp://localhost:${address.port}`);
	console.log(`\thttp://${hostname()}:${address.port}`);
	console.log(`\tGlobal chat on ws://localhost:${address.port}/chat/`);
});

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
function shutdown() { fastify.close(); process.exit(0); }

let port = parseInt(process.env.PORT || "");
if (isNaN(port)) port = 8080;
fastify.listen({ port, host: "0.0.0.0" });
