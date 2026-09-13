# SecScan Security Review

Review a source file or highlighted code in VS Code and save security findings and review coverage as Markdown reports.

Requires desktop VS Code 1.85 or newer and an internet connection. Registration is automatic; no account or API key is needed. Submitted code is sent to the SecScan service and OpenAI for review.

## How the review works

The model reads your submitted code without executing it. It traces inputs, sensitive operations, and security controls to identify supported vulnerabilities and suggest fixes.

SecScan's catalog groups checks into **24 overlapping categories** based on the code's purpose and trust boundaries, such as APIs, authentication, database queries, file handling, and cryptography. General security checks apply to every review. These are custom categories informed by sources including [MITRE CWE](https://cwe.mitre.org/data/definitions/699.html), [OWASP ASVS](https://owasp.org/www-project-application-security-verification-standard/), and the [OWASP API Security Top 10](https://owasp.org/API-Security/editions/2023/en/0x11-t10/), rather than an official classification from those sources.

The model selects a primary category and all applicable secondary categories from the operations present in your code, then reviews their combined checks plus the general checks. For example, an API that accepts uploads calls for API and file-handling checks, with database checks added if it also runs queries.

Findings include supporting code evidence, severity, confidence, and suggested fixes. The coverage report records which checks found issues, found none, did not apply, needed more context, or were not reviewed. Missing context is kept separate from confirmed findings; a clean report does not guarantee secure code.

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

Both commands are also available in the Command Palette. **Review File** uses the active file when run there. Reviews include unsaved edits and support up to **5,000 lines and 1 MiB of code**.

When the review finishes, select **Open findings** or open the reports in your chosen folder:

```text
security_review_findings_example.md
security_review_coverage_example.md
```

Repeated reviews add a number to the filenames so existing reports are preserved. Run **SecScan: Choose Output Folder** again to change the destination.

If the service is busy or a usage limit is reached, wait and try again later.
