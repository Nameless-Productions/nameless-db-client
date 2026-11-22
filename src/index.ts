import net from "net";
import readline from "readline";

type Pending = { resolve: (line: string) => void; reject: (err: Error) => void };

export class Client {
    private socket: net.Socket | null = null;
    private pending: Pending[] = [];

    constructor(private host: string, private port: number, private password: string) {}

    /** Opens the TCP connection and authenticates. */
    async connect(): Promise<void> {
        if (this.socket) throw new Error("Already connected");
        const socket = net.createConnection({ host: this.host, port: this.port });
        await new Promise<void>((resolve, reject) => {
            socket.once("connect", resolve);
            socket.once("error", reject);
        });
        this.socket = socket;

        // Replies arrive in order, one line per command (except DELETE).
        const rl = readline.createInterface({ input: socket });
        rl.on("line", (line) => {
            const p = this.pending.shift();
            if (!p) return;
            if (line.startsWith("ERROR")) p.reject(new Error(line.slice(6)));
            else p.resolve(line);
        });
        // readline re-emits socket errors; unhandled it would crash the process (socket handler below deals with them).
        rl.on("error", () => {});
        socket.on("error", (err) => this.fail(err));
        socket.on("close", () => this.fail(new Error("Connection closed")));

        try {
            await this.send(`AUTH ${this.password}`);
        } catch (err) {
            this.close();
            throw err;
        }
    }

    /** Closes the TCP connection. */
    close(): void {
        this.socket?.destroy();
        this.socket = null;
    }

    async ping(): Promise<void> {
        await this.send("PING");
    }

    /** Returns the value, or "" if the key doesn't exist (the server can't tell them apart). */
    async get(key: string): Promise<string> {
        const line = await this.send(`GET ${key}`);
        return line.slice(`VALUE ${key} `.length);
    }

    async set(key: string, value: string): Promise<void> {
        await this.send(`SET ${key} ${value}`);
    }

    /** The server sends no reply to DELETE, so this resolves once written. */
    async delete(key: string): Promise<void> {
        this.write(`DELETE ${key}`);
    }

    private fail(err: Error) {
        this.pending.splice(0).forEach((p) => p.reject(err));
        this.socket = null;
    }

    private write(line: string) {
        if (!this.socket) throw new Error("Not connected");
        // Protocol is line-based: a newline would smuggle in a second command.
        if (/[\r\n]/.test(line)) throw new Error("Keys and values can't contain newlines");
        this.socket.write(line + "\n");
    }

    private send(line: string): Promise<string> {
        return new Promise((resolve, reject) => {
            this.write(line);
            this.pending.push({ resolve, reject });
        });
    }
}
