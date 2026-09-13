import * as vscode from "vscode";
import { basename, isAbsolute } from "node:path";
import { reviewCode, backendUrl, registerInstallation } from "./secScan";
import { saveReports } from "./saveReports";
let busy = false;
let active: AbortController | undefined;
async function chooseFolder(): Promise<string | undefined> {
    const chosen = await vscode.window.showOpenDialog({ canSelectFolders: true, canSelectFiles: false, canSelectMany: false, openLabel: "Save reviews here" });
    if (!chosen?.length) return;
    if (chosen[0].scheme !== "file") throw new Error("Choose a filesystem folder.");
    const dir = chosen[0].fsPath;
    await vscode.workspace.getConfiguration("secScan").update("outputFolder", dir, vscode.ConfigurationTarget.Global);
    return dir;
}
export function activate(context: vscode.ExtensionContext): void {
    const run = async (selectionOnly: boolean, uri?: vscode.Uri) => {
        if (busy) { vscode.window.showWarningMessage("A review is already running."); return; }
        busy = true;
        try {
            const editor = vscode.window.activeTextEditor;
            let doc: vscode.TextDocument;
            let code: string;
            let start = 1;
            if (selectionOnly) {
                if (!editor || editor.selection.isEmpty) throw new Error("Highlight code first.");
                if (editor.selections.length > 1) throw new Error("Select one continuous range of code.");
                doc = editor.document;
                code = doc.getText(editor.selection);
                start = editor.selection.start.line + 1;
            } else {
                const target = uri || editor?.document.uri;
                if (!target) throw new Error("Select a file in Explorer or open a file first.");
                doc = await vscode.workspace.openTextDocument(target);
                code = doc.getText();
            }
            if (!code.trim()) throw new Error("The selected code is empty.");
            const count = code.replace(/\r?\n$/, "").split(/\r\n|\n|\r/).length;
            if (count > 5000) throw new Error("Select at most 5,000 lines for this review."); //change in order to change allowed selection parameters

            const config = vscode.workspace.getConfiguration("secScan");
            const dir = config.get<string>("outputFolder")?.trim() || await chooseFolder();
            if (!dir) return;
            if (!isAbsolute(dir)) throw new Error("Output folder must be an absolute path.");
            const endpoint = backendUrl(config.get<string>("backendUrl") || "");

            active = new AbortController();
            const controller = active;
            const paths = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: "Reviewing code…", cancellable: true }, async (_, token) => {
                const listener = token.onCancellationRequested(() => controller.abort());
                try {
                    const tokenKey = `installationToken:v1:${endpoint.origin}`;
                    let accessToken = await context.secrets.get(tokenKey);
                    if (!accessToken) {
                        accessToken = await registerInstallation(endpoint, controller.signal);
                        // Store even if cancellation arrived just after registration returned.
                        await context.secrets.store(tokenKey, accessToken);
                    }
                    controller.signal.throwIfAborted();
                    const result = await reviewCode(code, basename(doc.fileName), doc.languageId, start, endpoint, accessToken, controller.signal);
                    if (token.isCancellationRequested) return;
                    const saved = await saveReports(dir, doc.fileName, result.reports);
                    if (result.warning) void vscode.window.showWarningMessage(`${result.warning} Saved: ${saved.join(", ")}`);
                    return saved;
                } finally { listener.dispose(); }
            });
            if (paths) {
                void vscode.window.showInformationMessage(
                    `Saved reports to ${dir}`,
                    "Open findings"
                ).then(async (action) => {
                    if (action) {
                        try {
                            await vscode.window.showTextDocument(
                                await vscode.workspace.openTextDocument(paths[0])
                            );
                        } catch (error) {
                            void vscode.window.showErrorMessage(String(error));
                        }
                    }
                });
            }
        } catch (error) {
            if (!active?.signal.aborted) vscode.window.showErrorMessage(error instanceof Error ? error.message : String(error));
        } 
        finally { busy = false; active = undefined; } 

    };
    context.subscriptions.push(
        vscode.commands.registerCommand("secScan.reviewFile", (uri?: vscode.Uri) => run(false, uri)),
        vscode.commands.registerCommand("secScan.reviewSelection", () => run(true)),
        vscode.commands.registerCommand("secScan.chooseOutputFolder", () => chooseFolder().catch(e => vscode.window.showErrorMessage(String(e)))),
    );
}
export function deactivate(): void { active?.abort(); }

