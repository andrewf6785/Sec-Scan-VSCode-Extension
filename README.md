# SecScan Security Review

Review a source file or highlighted code in VS Code and save security findings and review coverage as Markdown reports.

Requires desktop VS Code 1.85 or newer and an internet connection. Registration is automatic; no account or API key is needed. Submitted code is sent to the SecScan service and OpenAI for review.

## Install

### From the Marketplace

Open **Extensions** in VS Code, search for **SecScan Security Review**, and select **Install**.

### From GitHub

If a `.vsix` file is provided with the release, download it. In VS Code, open the Command Palette and run **Extensions: Install from VSIX…**, then select the downloaded file. See [VS Code's installation instructions](https://code.visualstudio.com/docs/configure/extensions/extension-marketplace#install-from-a-vsix).

If you downloaded the source code instead:

1. Install [Node.js](https://nodejs.org/) 22 or newer, which includes npm.
2. Extract or clone the repository and open a terminal in its **`extension`** folder.
3. Run:

   ```sh
   npm ci
   npx @vscode/vsce package --allow-missing-repository
   ```

4. Install the generated `.vsix` using **Extensions: Install from VSIX…**. Packaging compiles the extension automatically.

## First-time setup

1. Open the Command Palette: **Ctrl+Shift+P** on Windows/Linux or **Cmd+Shift+P** on macOS.
2. Run **SecScan: Choose Output Folder** and select where reports should be saved.

The extension registers automatically when you run your first review. If it asks for a backend URL, open **User Settings**, search for `secScan.backendUrl`, and enter:

```text
https://cyberscurity-scan-vscode-extension.onrender.com
```

## Run a review

Open the folder containing your code, then choose either:

- **Whole file:** right-click a file in Explorer and select **SecScan: Review File**.
- **Selected code:** highlight one continuous selection, right-click, and select **SecScan: Review Selection**.

Both commands are also available in the Command Palette. **Review File** uses the active file when run there. Reviews include unsaved edits and support up to **1,000 lines and 200 KiB of code**.

When the review finishes, select **Open findings** or open the reports in your chosen folder:

```text
security_review_findings_example.md
security_review_coverage_example.md
```

Repeated reviews add a number to the filenames so existing reports are preserved. Run **SecScan: Choose Output Folder** again to change the destination.

If the service is busy or a usage limit is reached, wait and try again later.
