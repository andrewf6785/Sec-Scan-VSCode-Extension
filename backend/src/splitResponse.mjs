export function splitResponse(text) {
    // Match a standalone title, not a table-of-contents link or inline mention.
    const lines = /[^\r\n]*(?:\r\n|\n|\r|$)/g;
    for (const match of text.matchAll(lines)) {
        let title = match[0].trim();
        title = title.replace(/^#{1,6}[ \t]+/, "").replace(/[ \t]+#+$/, "").trim();
        title = title.replace(/:$/, "").trim();
        if ((title.startsWith("**") && title.endsWith("**")) ||
            (title.startsWith("__") && title.endsWith("__"))) {
            title = title.slice(2, -2).trim();
        }
        title = title.replace(/:$/, "").trim();
        if (/^SECURITY[ \t]+REVIEW[ \t]+COVERAGE$/i.test(title)) {
            const index = match.index;
            return { findings: text.slice(0, index), coverage: text.slice(index) };
        }
    }
    throw new Error("No standalone Security Review Coverage heading found in the response.");
}
