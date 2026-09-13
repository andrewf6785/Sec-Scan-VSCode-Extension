import { request as httpsRequest } from "node:https";
import { request as httpRequest } from "node:http";

export interface ReviewResult { reports: { prefix: string; text: string }[]; warning?: string; }
export function backendUrl(value: string): URL {
    let url: URL;
    try { url = new URL(value.trim()); } catch { throw new Error("Set secScan.backendUrl in User Settings to your Render HTTPS URL."); }
    const local = url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
    if ((url.protocol !== "https:" && !local) || url.username || url.password || url.search || url.hash || url.pathname !== "/") {
        throw new Error("Use an HTTPS service origin, with no path, credentials, query or fragment. HTTP is allowed only for localhost testing.");
    }
    return url;
}
function post(endpoint: URL, path: string, body: string, signal: AbortSignal, token?: string): Promise<any> {
    return new Promise((resolve, reject) => {
        if (Buffer.byteLength(body) > 512 * 1024) { reject(new Error("Review input exceeds 512 KiB.")); return; }
        const request = endpoint.protocol === "https:" ? httpsRequest : httpRequest;
        const headers: Record<string, string | number> = { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) };
        if (token) headers.Authorization = `Bearer ${token}`;
        const req = request(new URL(path, endpoint), { method: "POST", signal, headers }, res => {
            const chunks: Buffer[] = []; let size = 0;
            res.on("data", (chunk: Buffer) => {
                size += chunk.length;
                if (size > 2 * 1024 * 1024) { req.destroy(new Error("Backend response exceeds 2 MiB.")); return; }
                chunks.push(chunk);
            });
            res.on("error", reject);
            res.on("end", () => {
                try {
                    // Never automatically replace a rejected/revoked token: that would undo revocation.
                    if (res.statusCode === 401 || res.statusCode === 403) throw new Error("This SecScan installation is invalid or disabled. Contact the service owner.");
                    if (res.statusCode === 429) throw new Error(path === "/register"
                        ? "SecScan registration is temporarily at capacity. Try again later."
                        : "SecScan review allowance reached or service busy. Try again later.");
                    const expected = path === "/register" ? 201 : 200;
                    if (res.statusCode !== expected) throw new Error(`SecScan service returned HTTP ${res.statusCode}. Try again later.`);
                    resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
                } catch (e) { reject(e); }
            });
        });
        const timer = setTimeout(() => req.destroy(new Error("SecScan request timed out. Try again later.")), path === "/register" ? 90_000 : 300_000);
        req.on("error", reject);
        req.on("close", () => clearTimeout(timer));
        req.end(body);
    });
}
export async function registerInstallation(endpoint: URL, signal: AbortSignal): Promise<string> {
    const data = await post(endpoint, "/register", "{}", signal);
    if (typeof data?.token !== "string" || !/^[a-f0-9]{64}$/.test(data.token)) throw new Error("Invalid registration response.");
    return data.token;
}
export async function reviewCode(code: string, filename: string, language: string, startLine: number,
    endpoint: URL, token: string, signal: AbortSignal): Promise<ReviewResult> {
    const data = await post(endpoint, "/review", JSON.stringify({ code, filename, language, startLine }), signal, token);
    const reports = data?.reports;
    const pair = Array.isArray(reports) && reports.length === 2 && reports[0]?.prefix === "security_review_findings" && reports[1]?.prefix === "security_review_coverage";
    const raw = Array.isArray(reports) && reports.length === 1 && reports[0]?.prefix === "security_review_raw_response";
    if ((!pair && !raw) || !reports.every((p: any) => typeof p.text === "string") || (data.warning !== undefined && typeof data.warning !== "string")) {
        throw new Error("Unexpected report format from backend.");
    }
    return { reports: reports.map((p: any) => ({ prefix: p.prefix, text: p.text })), warning: data.warning };
}
