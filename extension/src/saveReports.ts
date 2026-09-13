import { mkdir, open, unlink } from "node:fs/promises";
import { basename, extname, join } from "node:path";
export async function saveReports(dir: string, filename: string, parts: { prefix: string; text: string }[]): Promise<string[]> {
    await mkdir(dir, { recursive: true });
    const base = basename(filename, extname(filename)).replace(/[^a-zA-Z0-9_.-]/g, "_").slice(0, 100) || "code";
    for (let n = 1; ; n++) {
        const suffix = n === 1 ? "" : `_${n}`;
        const paths = parts.map(p => join(dir, `${p.prefix}_${base}${suffix}.md`));
        const handles: Awaited<ReturnType<typeof open>>[] = [];
        try {
            for (const path of paths) handles.push(await open(path, "wx"));
        } catch (error) {
            await Promise.all(handles.map(h => h.close()));
            await Promise.all(paths.slice(0, handles.length).map(path => unlink(path)));
            if ((error as NodeJS.ErrnoException).code === "EEXIST") continue;
            throw error;
        }
        try {
            for (let i = 0; i < handles.length; i++) await handles[i].writeFile(parts[i].text, "utf8");
        } finally {
            await Promise.all(handles.map(h => h.close()));
        }
        return paths;
    }
}
