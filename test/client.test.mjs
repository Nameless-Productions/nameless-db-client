import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import readline from "node:readline";
import { Client } from "../dist/index.js";

// Minimal fake of nameless-db's line protocol (same replies as the real server).
const store = new Map();
const sockets = new Set();
const server = net.createServer((socket) => {
    sockets.add(socket);
    let authed = false;
    readline.createInterface({ input: socket }).on("line", (line) => {
        const [cmd, key, ...rest] = line.split(" ");
        if (cmd === "AUTH") {
            if (key !== "pw") return void socket.write("ERROR Incorrect password\n");
            authed = true;
            return void socket.write("HELLO\n");
        }
        if (!authed) return void socket.write("ERROR not authed\n");
        if (cmd === "PING") socket.write("PONG\n");
        else if (cmd === "SET") { store.set(key, rest.join(" ")); socket.write(`VALUE ${key} ${rest.join(" ")}\n`); }
        else if (cmd === "GET") socket.write(`VALUE ${key} ${store.get(key) ?? ""}\n`);
        else if (cmd === "DELETE") store.delete(key); // no reply, like the real server
        else socket.write("ERROR Command not found\n");
    });
});
let port;
before(() => new Promise((r) => server.listen(0, () => { port = server.address().port; r(); })));
after(() => server.close());

async function connected() {
    const c = new Client("127.0.0.1", port, "pw");
    await c.connect();
    return c;
}

test("set/get round-trips values with spaces", async () => {
    const c = await connected();
    await c.set("k", "hello big world");
    assert.equal(await c.get("k"), "hello big world");
    c.close();
});

test("get of a missing key is an empty string", async () => {
    const c = await connected();
    assert.equal(await c.get("nope"), "");
    c.close();
});

test("delete removes the key and doesn't desync later replies", async () => {
    const c = await connected();
    await c.set("d", "1");
    await c.delete("d");
    assert.equal(await c.get("d"), "");
    await c.ping();
    c.close();
});

test("wrong password rejects connect", async () => {
    const c = new Client("127.0.0.1", port, "bad");
    await assert.rejects(c.connect(), /Incorrect password/);
});

test("commands before connect reject", async () => {
    await assert.rejects(new Client("127.0.0.1", port, "pw").get("x"), /Not connected/);
});

test("newlines in values are refused", async () => {
    const c = await connected();
    await assert.rejects(c.set("k", "a\nDELETE k"), /newlines/);
    c.close();
});

test("pending request rejects when the server drops the connection", async () => {
    const c = await connected();
    const p = c.get("x");
    sockets.forEach((s) => s.destroy());
    await assert.rejects(p, /Connection closed|ECONNRESET/);
});
