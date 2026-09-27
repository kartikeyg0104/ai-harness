import * as vscode from "vscode";
import crypto from "node:crypto";
import type { JarvisSnapshot } from "../jarvis/session";

/** The one page the extension shows: mission, the person's next decision, progress, details, and Jarvis. */
export interface HomeState {
  mission: {
    id: string;
    title: string;
    loop: string;
    phase: string;
    complexity: string;
    mode: string;
    activity: string | null;
    running: boolean;
    createdAt: string;
  } | null;
  gate: HomeGate | null;
  release: { state: string; criteria: Array<{ id: string; label: string; state: string; detail: string }> } | null;
  requirements: Array<{ id: string; title: string; status: string }>;
  tickets: Array<{ ref: string; title: string; risk: string }>;
  evidence: Array<{ kind: string; result: string; story: string; at: string; artifact: string }>;
  findings: Array<{ code: string; message: string; severity: string }>;
  jarvis: JarvisSnapshot | null;
  composer: { error: string | null };
  acceptor: string;
  model: string;
}

export type HomeGate =
  | { kind: "forge"; key: string; index: number; total: number; prompt: string; why: string }
  | { kind: "accept"; key: string; tickets: Array<{ ref: string; title: string }> }
  | { kind: "approve"; key: string }
  | { kind: "resume"; key: string; reason: string };

/** One past or current mission, for the history page. */
export interface HistoryItem {
  id: string;
  title: string;
  loop: string;
  createdAt: string;
  updatedAt: string;
  active: boolean;
}

export type HomeAction =
  | { type: "ready" }
  | { type: "submit"; text: string }
  | { type: "ask"; text: string }
  | { type: "forgeAnswer"; text: string }
  | { type: "acceptTickets"; identity: string }
  | { type: "approveRelease"; identity: string; reason: string }
  | { type: "resumeAutopilot" }
  | { type: "stopAutopilot" }
  | { type: "openFile"; path: string }
  | { type: "loadHistory" }
  | { type: "openMission"; id: string }
  | { type: "cancel" }
  | { type: "jarvis"; action: "activate" | "exit" | "pause" | "resume" | "stopSpeaking" | "pttStart" | "pttStop" | "handsFree" | "wakeWord" };

/**
 * The page is static; the extension posts state and the page renders it. Nothing is ever reloaded, so what a person
 * types, where they scrolled, and which sections they opened survive every update.
 */
export class HomeView implements vscode.WebviewViewProvider {
  private view: vscode.WebviewView | null = null;
  private last: HomeState | null = null;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly onAction: (action: HomeAction) => void,
  ) {}

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    const media = vscode.Uri.joinPath(this.extensionUri, "media");
    view.webview.options = { enableScripts: true, localResourceRoots: [media] };
    view.webview.html = page(view.webview, media);
    view.webview.onDidReceiveMessage((message: HomeAction) => {
      if (message.type === "ready") {
        if (this.last) void view.webview.postMessage({ type: "state", state: this.last });
      } else this.onAction(message);
    });
    view.onDidDispose(() => {
      this.view = null;
    });
  }

  post(state: HomeState): void {
    this.last = state;
    if (this.view) this.view.description = state.mission ? (state.mission.running ? "running" : state.mission.loop) : undefined;
    void this.view?.webview.postMessage({ type: "state", state });
  }

  /** Switches the page: a clean new-mission screen, the mission history, or the active mission. */
  show(page: "new" | "history" | "mission"): void {
    void this.view?.webview.postMessage({ type: "show", page });
  }

  history(items: HistoryItem[]): void {
    void this.view?.webview.postMessage({ type: "history", items });
  }

  reveal(section: string): void {
    void this.view?.webview.postMessage({ type: "reveal", section });
  }
}

function page(webview: vscode.Webview, media: vscode.Uri): string {
  const nonce = crypto.randomBytes(16).toString("base64");
  const css = webview.asWebviewUri(vscode.Uri.joinPath(media, "home.css"));
  const js = webview.asWebviewUri(vscode.Uri.joinPath(media, "home.js"));
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource} data:; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';" />
<link rel="stylesheet" href="${css.toString()}" />
<title>BMAD Next</title>
</head>
<body>
<div id="app" class="app" aria-busy="true"></div>
<script nonce="${nonce}" src="${js.toString()}"></script>
</body>
</html>`;
}
