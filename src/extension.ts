// src/extension.ts — Day 8: NLU flags + client_hints + replicas UI
import * as vscode from 'vscode';
import * as fs from 'fs';
import { randomUUID } from 'crypto';


// ---- User & API types ----
interface VSCodeUser {
  username: string;
  email?: string;
  displayName?: string;
}

interface JobResponse {
  success: boolean;
  job_id: string;
  parsed_intent: {
    action: string;
    service?: string;
    environment?: string;
    confidence: number;
    replicas?: number; // can be returned by server
    source?: string;   // NEW: server includes parsing source (hf:..., regex, etc)
  };
  status: string;
  created_at: string;
}

interface JobDetails {
  id: string;
  original_command: string;
  parsed_intent: any;
  job_type: string;
  status: string;
  output?: string[];
  error_message?: string;
  created_at: string;
  updated_at: string;
}

interface ApiEnvironment {
  label: string;
  description: string;
  url: string;
}

const API_ENVIRONMENTS: ApiEnvironment[] = [
  { label: 'Local Development', description: 'http://localhost:3001', url: 'http://localhost:3001' },
  { label: 'Staging', description: 'https://staging-api.devcommandhub.com', url: 'https://staging-api.devcommandhub.com' },
  { label: 'Production', description: 'https://api.devcommandhub.com', url: 'https://api.devcommandhub.com' },
  { label: 'Custom...', description: 'Enter a custom API base URL', url: 'custom' }
];

/** ---------- Small helper: parse client-side hints from free text ---------- */
function parseClientHints(command: string): Record<string, any> {
  const txt = (command || '').toLowerCase();
  // Try to infer replicas: "scale backend to 5 replicas", "replicas=4", "scale 3"
  const m1 = txt.match(/\b(?:to|=)\s*(\d+)\s*(?:replicas?|pods?)\b/);
  const m2 = txt.match(/\bscale\b[^\d]*(\d+)\b/);
  const n = m1?.[1] || m2?.[1];
  const hints: any = {};
  if (n) { hints.replicas = Number(n); }
  return hints;
}

// ---- Provider ----
class DevCommandHubProvider implements vscode.Disposable {
  private panel?: vscode.WebviewPanel;
  private pollingJobs = new Set<string>();
  private isProcessingCommand = false;
  private currentJobId: string | null = null;

  // Day 7: user state
  private currentUser: VSCodeUser | null = null;

  constructor(private context: vscode.ExtensionContext) {
    this.initializeUser();

    // NEW: react to settings changes without reload (useful while testing)
    this.context.subscriptions.push(
      vscode.workspace.onDidChangeConfiguration(e => {
        if (e.affectsConfiguration('devcommandhub')) {
          if (this.panel) {
            // Light ping so the webview could update banners later if needed
            this.panel.webview.postMessage({ command: 'settingsChanged' });
          }
        }
      })
    );
  }

  dispose() {
    if (this.panel) {
      this.pollingJobs.clear();
      this.isProcessingCommand = false;
      this.currentJobId = null;
      this.panel.dispose();
      this.panel = undefined;
    }
  }

  // ---- User detection (VS Code / OS / Git fallbacks) ----
  private async initializeUser() {
    try {
      let username = 'developer';
      try {
        const os = await import('os');
        username = os.userInfo().username || 'developer';
      } catch { /* noop */ }

      let email: string | undefined;
      let displayName: string | undefined;

      try {
        const gitConfig = vscode.workspace.getConfiguration('git');
        email = gitConfig.get<string>('userEmail');
        displayName = gitConfig.get<string>('userName');
      } catch (e) {
        console.log('[DCH] Could not read git user config:', e);
      }

      this.currentUser = {
        username,
        email,
        displayName: displayName || username,
      };

      console.log('[DCH] User initialized:', this.currentUser);
    } catch (e) {
      console.warn('[DCH] initializeUser failed, using defaults:', e);
      this.currentUser = { username: 'developer', displayName: 'Developer' };
    }
  }

  private isUuid(s?: string): boolean {
  return !!s && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(s);
}

private getStableUserId(): string {
  // 1) prefer a valid UUID from settings (if set)
  const cfgId = vscode.workspace.getConfiguration('devcommandhub').get<string>('userId', '')?.trim();
  if (this.isUuid(cfgId)) {return cfgId!;}

  // 2) otherwise cache one in globalState
  let cached = this.context.globalState.get<string>('dch.userId');
  if (this.isUuid(cached)) {return cached!;}

  cached = randomUUID();
  this.context.globalState.update('dch.userId', cached);
  return cached;
}


  private getUserAvatarText(): string {
    if (!this.currentUser) { return 'D'; }
    const name = this.currentUser.displayName || this.currentUser.username || 'D';
    if (name.includes(' ')) {
      const parts = name.trim().split(/\s+/);
      return ((parts[0][0] || '') + (parts[parts.length - 1][0] || '')).toUpperCase();
    }
    return name.slice(0, 2).toUpperCase();
  }

  // ---- Helpers ----
  private getApiBaseUrl(): string {
    return vscode.workspace.getConfiguration('devcommandhub').get('apiBaseUrl', 'http://localhost:3001');
  }

  // NEW: read current NLU settings
  private getNluSettings(): { enableNLU: boolean; confidenceThreshold: number; userId?: string } {
    const cfg = vscode.workspace.getConfiguration('devcommandhub');
    const enableNLU = cfg.get<boolean>('enableNLU', true);
    const confidenceThreshold = cfg.get<number>('confidenceThreshold', 0.6);
    const userId = cfg.get<string>('userId', '')?.trim() || undefined;
    return { enableNLU, confidenceThreshold, userId };
  }

  private getNonce(): string {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    let s = '';
    for (let i = 0; i < 32; i++) { s += chars[Math.floor(Math.random() * chars.length)]; }
    return s;
  }

  // ---- Webview ----
  async openWindow() {
    if (this.panel) {
      this.panel.reveal(vscode.ViewColumn.Beside);
      return;
    }

    this.panel = vscode.window.createWebviewPanel(
      'devcommandhub.panel',
      'DevCommandHub Panel',
      vscode.ViewColumn.Beside,
      { enableScripts: true, retainContextWhenHidden: true }
    );

    const htmlPath = vscode.Uri.joinPath(this.context.extensionUri, 'media.html');
    let html = fs.readFileSync(htmlPath.fsPath, 'utf-8');

    // Ensure buttons enabled on first load
    html = html
      .replace(/(<button[^>]*id="askBtn"[^>]*)(\sdisabled)?/i, '$1')
      .replace(/(<button[^>]*id="submitBtn"[^>]*)(\sdisabled)?/i, '$1');

    const nonce = this.getNonce();
    const cspMeta = `
<meta http-equiv="Content-Security-Policy"
  content="default-src 'none';
           img-src ${this.panel.webview.cspSource} https: data:;
           style-src ${this.panel.webview.cspSource} 'unsafe-inline';
           font-src ${this.panel.webview.cspSource} https: data:;
           script-src 'nonce-${nonce}';">`;

    if (!/http-equiv=["']Content-Security-Policy["']/i.test(html)) {
      html = html.replace(/<\/head>/i, `${cspMeta}\n</head>`);
    }

    const controller = this.getControllerScript(nonce);

    const endIdx = html.toLowerCase().lastIndexOf('</body>');
    if (endIdx >= 0) {
      html = html.slice(0, endIdx) + `\n${controller}\n` + html.slice(endIdx);
    } else {
      html += `\n${controller}\n`;
    }

    this.panel.webview.html = html;

    // Messages from webview
    this.panel.webview.onDidReceiveMessage(async (message) => {
      switch (message.command) {
        case 'sendDevCommand':
          await this.handleDevCommand(message.text);
          break;
        case 'refreshJob':
          if (message.jobId) { await this.refreshJobStatus(message.jobId); }
          break;
        case 'retryJob':
          if (!message.originalCommand) { break; }
          if (this.isProcessingCommand) {
            this.panel?.webview.postMessage({
              command: 'showBusyMessage',
              message: 'A command is already running. Please wait for it to finish.'
            });
            return;
          }
          await this.handleDevCommand(message.originalCommand);
          break;
        case 'requestUserInfo':
          this.panel?.webview.postMessage({
            command: 'updateUserInfo',
            user: this.currentUser,
            avatarText: this.getUserAvatarText()
          });
          break;
      }
    }, undefined, this.context.subscriptions);

    this.panel.onDidDispose(() => {
      this.pollingJobs.clear();
      this.isProcessingCommand = false;
      this.currentJobId = null;
      this.panel = undefined;
    }, null, this.context.subscriptions);

    // Send user info to the webview shortly after creation
    if (this.currentUser) {
      setTimeout(() => {
        this.panel?.webview.postMessage({
          command: 'updateUserInfo',
          user: this.currentUser,
          avatarText: this.getUserAvatarText()
        });
      }, 100);
    }
  }

  // ---- Command handling ----
  private async handleDevCommand(command: string) {
    if (!this.panel) { return; }

    if (this.isProcessingCommand) {
      console.log(`[DCH] Command already in progress, ignoring: "${command}"`);
      this.panel.webview.postMessage({
        command: 'showBusyMessage',
        message: 'Please wait for the current command to complete before sending another.'
      });
      return;
    }

    this.isProcessingCommand = true;

    try {
      this.panel.webview.postMessage({ command: 'setLoadingState', loading: true });
      this.panel.webview.postMessage({ command: 'showTyping' });

      const response = await this.sendCommandToAPI(command);
      if (!response.success) { throw new Error('Failed to create job'); }

      this.currentJobId = response.job_id;

      const jobResponse = {
        type: 'job_created',
        job_id: response.job_id,
        parsed_intent: response.parsed_intent,
        status: response.status,
        created_at: response.created_at,
        original_command: command
      };

      this.panel.webview.postMessage({ command: 'addDevResponse', response: jobResponse });

      if (response.status === 'queued' || response.status === 'running') {
        this.startJobPolling(response.job_id);
      } else {
        this.isProcessingCommand = false;
        this.currentJobId = null;
        this.panel.webview.postMessage({ command: 'setLoadingState', loading: false });
      }
    } catch (error) {
      console.error('[DCH] Error in handleDevCommand:', error);
      this.showErrorToast(`Network error: ${error instanceof Error ? error.message : 'Unknown error'}`);

      this.panel.webview.postMessage({
        command: 'addDevResponse',
        response: {
          type: 'error',
          message: error instanceof Error ? error.message : 'Unknown error occurred',
          original_command: command,
          show_retry: true
        }
      });

      this.isProcessingCommand = false;
      this.currentJobId = null;
      this.panel.webview.postMessage({ command: 'setLoadingState', loading: false });
    }
  }

  private showErrorToast(message: string) {
    vscode.window.showErrorMessage(`DevCommandHub: ${message}`, 'Retry', 'Dismiss').then(sel => {
      if (sel === 'Retry') { console.log('[DCH] User selected retry from error toast'); }
    });
  }

  private async startJobPolling(jobId: string, maxAttempts: number = 60) {
    if (this.pollingJobs.has(jobId)) {
      console.log(`[DCH] Already polling job ${jobId}`);
      return;
    }

    console.log(`[DCH] Starting polling for job ${jobId}, max attempts: ${maxAttempts}`);
    this.pollingJobs.add(jobId);
    let attempts = 0;

    const poll = async () => {
      if (!this.panel || !this.pollingJobs.has(jobId)) {
        console.log(`[DCH] Stopping polling for job ${jobId} (panel disposed or cancelled)`);
        return;
      }

      attempts++;
      console.log(`[DCH] Polling attempt ${attempts}/${maxAttempts} for job ${jobId}`);

      try {
        const job = await this.getJobDetails(jobId);
        console.log(`[DCH] Job ${jobId} status: ${job.status}`);

        this.panel.webview.postMessage({
          command: 'updateJobStatus',
          jobId,
          status: job.status,
          output: job.output,
          error_message: job.error_message,
          original_command: job.original_command
        });

        const terminalStates = ['completed', 'failed', 'cancelled'];
        if (terminalStates.includes(job.status)) {
          console.log(`[DCH] Job ${jobId} reached terminal state: ${job.status}`);
          this.pollingJobs.delete(jobId);

          if (this.currentJobId === jobId) {
            this.currentJobId = null;
            this.isProcessingCommand = false;
            if (this.panel) { this.panel.webview.postMessage({ command: 'setLoadingState', loading: false }); }
          }
          return;
        }

        if (attempts >= maxAttempts) {
          console.log(`[DCH] Max polling attempts reached for job ${jobId}`);
          this.pollingJobs.delete(jobId);

          if (this.currentJobId === jobId) {
            this.currentJobId = null;
            this.isProcessingCommand = false;
            if (this.panel) { this.panel.webview.postMessage({ command: 'setLoadingState', loading: false }); }
          }
          return;
        }

        const delay = 3000 + Math.random() * 2000;
        setTimeout(poll, delay);
      } catch (error) {
        console.error(`[DCH] Error polling job ${jobId}:`, error);
        if (attempts < maxAttempts) {
          const delay = Math.min(30000, 1000 * Math.pow(2, Math.min(attempts, 5)));
          console.log(`[DCH] Retrying job ${jobId} polling in ${delay}ms`);
          setTimeout(poll, delay);
        } else {
          if (this.panel) {
            this.panel.webview.postMessage({
              command: 'showPollingError',
              jobId,
              message: 'Failed to get job status updates'
            });
            if (this.currentJobId === jobId) {
              this.currentJobId = null;
              this.isProcessingCommand = false;
              this.panel.webview.postMessage({ command: 'setLoadingState', loading: false });
            }
          }
          this.pollingJobs.delete(jobId);
        }
      }
    };

    setTimeout(poll, 2000);
  }

  // Refresh job status and update the webview
  private async refreshJobStatus(jobId: string) {
    if (!this.panel) { return; }
    try {
      const job = await this.getJobDetails(jobId);
      this.panel.webview.postMessage({
        command: 'updateJobStatus',
        jobId,
        status: job.status,
        output: job.output,
        error_message: job.error_message,
        original_command: job.original_command
      });
      const terminalStates = ['completed', 'failed', 'cancelled'];
      if (!terminalStates.includes(job.status)) {
        this.startJobPolling(jobId);
      }
    } catch (error) {
      console.error('[DCH] Error refreshing job status:', error);
      this.panel.webview.postMessage({
        command: 'showPollingError',
        jobId,
        message: 'Failed to refresh job status'
      });
    }
  }

  // ---------- API calls ----------
  private getHFHeaders(): Record<string, string> {
    // Read from settings: devcommandhub.hfToken (string)
    const token = vscode.workspace.getConfiguration('devcommandhub')
      .get<string>('hfToken', '')?.trim();
    return token ? { 'X-HF-API-Key': token } : {};
  }

  p;// ---------- API calls ----------
// ---------- API calls ----------
// Updated sendCommandToAPI method
private async sendCommandToAPI(command: string, opts?: { slotOverrides?: Record<string, any> }): Promise<any> {
  const { enableNLU, confidenceThreshold, userId } = this.getNluSettings();
  const apiBase = this.getApiBaseUrl();
  const validUUID = (s: string) =>
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(s);
  
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  
  // Add user ID header if valid UUID
  if (userId && validUUID(userId)) {
    headers['X-DCH-User-Id'] = userId;   // header for server side convenience
  }

  // client-side hints (replicas, etc.)
  const clientHints = parseClientHints(command);

  // build body with user_id if valid UUID
  const body: any = {
    command,
    enableNLU,
    clientHints,
    ...(typeof confidenceThreshold === 'number' ? { confidenceThreshold } : {}),
    ...(userId && validUUID(userId) ? { user_id: userId } : { user_id: this.getStableUserId() })
  };
  
  if (opts?.slotOverrides) {
    body.slotOverrides = opts.slotOverrides;
  }

  const res = await fetch(`${apiBase}/api/commands`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });

  const data = await res.json().catch(() => ({} as any));

  if (!res.ok) {
    // slot-filling (e.g. rollback missing service)
    if (res.status === 422 && (data as any)?.code === 'MISSING_SLOT' && Array.isArray((data as any).missing)) {
      if ((data as any).missing.includes('service')) {
        const cfg = vscode.workspace.getConfiguration('devcommandhub');
        const known = cfg.get<string[]>('services', ['frontend','api','backend','auth-service','user-service','database-service']);
        const picked = await vscode.window.showQuickPick(known.map(label => ({ label })), {
          placeHolder: (data as any)?.message ?? 'Pick a service',
        });
        const service = picked?.label || await vscode.window.showInputBox({
          prompt: (data as any)?.message ?? 'Which service?',
          placeHolder: 'e.g. auth-service',
        });
        if (!service) {throw new Error('User cancelled slot fill');}

        const retryBody = { ...body, slotOverrides: { ...(body.slotOverrides || {}), service } };
        const retryRes = await fetch(`${apiBase}/api/commands`, {
          method: 'POST',
          headers,
          body: JSON.stringify(retryBody),
        });
        if (!retryRes.ok) {
          const err = await retryRes.text();
          throw new Error(`API request failed (retry): ${retryRes.status} — ${err}`);
        }
        return retryRes.json();
      }
    }

    throw new Error(`API request failed: ${res.status} ${res.statusText} — ${JSON.stringify(data)}`);
  }

  return data;
}



  private async getJobDetails(jobId: string): Promise<JobDetails> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 15000);
    try {
      const resp = await fetch(`${this.getApiBaseUrl()}/api/jobs/${jobId}`, { signal: controller.signal });
      clearTimeout(timeoutId);
      if (!resp.ok) { throw new Error(`Failed to fetch job details: ${resp.status} ${resp.statusText}`); }
      const result = (await resp.json()) as { job: JobDetails };
      return result.job;
    } catch (error: any) {
      clearTimeout(timeoutId);
      if (error && error.name === 'AbortError') { throw new Error('Job status request timed out'); }
      throw error;
    }
  }

  private getControllerScript(nonce: string): string {
    return `
<script nonce="${nonce}">
(function () {
  window.onerror = function (msg, src, line, col, err) {
    console.error('[DCH] Webview error:', msg, src + ':' + line + ':' + col, err);
  };

  console.log('[DCH] controller: start');

  var vscode = window.vscode || (typeof acquireVsCodeApi === 'function' ? acquireVsCodeApi() : null);
  window.vscode = vscode;

  // ---------- State ----------
  var currentUser = { username: 'developer', displayName: 'Developer' };
  var currentAvatarText = 'D';
  var isLoading = false;

  function byId(id){ return document.getElementById(id); }

  // ---------- Highlighting ----------
  function highlightCode(text) {
    if (!text) return '';
    return text
      .replace(/(\\{[^}]*\\}|\\[[^\\]]*\\])/g, '<span class="syntax-json">$1</span>')
      .replace(/(ERROR|FATAL|FAIL|Exception|Error:)/gi, '<span class="syntax-error">$1</span>')
      .replace(/(WARN|WARNING|DEPRECATED)/gi, '<span class="syntax-warning">$1</span>')
      .replace(/(SUCCESS|OK|COMPLETE|DONE|✓)/gi, '<span class="syntax-success">$1</span>')
      .replace(/(INFO|DEBUG|LOG)/gi, '<span class="syntax-info">$1</span>')
      .replace(/(https?:\\/\\/[^\\s]+)/g, '<span class="syntax-url">$1</span>')
      .replace(/(pod|service|deployment|namespace)/gi, '<span class="syntax-k8s">$1</span>')
      .replace(/(\\/[^\\s]*\\.[^\\s]*)/g, '<span class="syntax-path">$1</span>')
      .replace(/\\b(\\d+)\\b/g, '<span class="syntax-number">$1</span>');
  }

  // ---------- Collapsible output (no inline onclicks) ----------
  function createCollapsibleOutput(content, title, type) {
    if (!content || (Array.isArray(content) && content.length === 0)) return '';
    var text = Array.isArray(content) ? content.join('\\n') : String(content);
    var lines = text.split('\\n');
    var isLong = lines.length > 10 || text.length > 1000;

    var id = 'collapse-' + Math.random().toString(36).slice(2, 11);
    var cls = (type === 'error') ? 'error-content' : 'output-content';

    if (!isLong) {
      return '<div class="code-block ' + cls + '">' + highlightCode(text) + '</div>';
    }

    var preview = lines.slice(0,5).join('\\n');
    var rest = lines.slice(5).join('\\n');
    var more = lines.length - 5;

    return ''
      + '<div class="collapsible-output" data-block-id="' + id + '">'
      +   '<div class="code-block ' + cls + '">'
      +     highlightCode(preview)
      +     '<div class="output-preview-fade"></div>'
      +   '</div>'
      +   '<button class="expand-btn" data-target="' + id + '">▶ Show ' + more + ' more lines</button>'
      +   '<div id="' + id + '" class="collapsed-content" style="display:none;">'
      +     '<div class="code-block ' + cls + '">' + highlightCode(rest) + '</div>'
      +     '<button class="collapse-btn" data-target="' + id + '">▲ Show less</button>'
      +   '</div>'
      + '</div>';
  }

  // Single delegated handler (CSP-safe)
  document.addEventListener('click', function (ev) {
    try {
      var t = ev.target;
      if (!t || !t.classList) return;

      if (t.classList.contains('expand-btn') || t.classList.contains('collapse-btn')) {
        var id = t.getAttribute('data-target');
        if (!id) return;
        var content = document.getElementById(id);
        if (!content) return;

        var expandBtn = content.previousElementSibling; // the expand button
        var expanded = content.style.display !== 'none';

        if (expanded) {
          content.style.display = 'none';
          if (expandBtn && expandBtn.classList && expandBtn.classList.contains('expand-btn')) {
            expandBtn.style.display = 'block';
          }
        } else {
          content.style.display = 'block';
          if (expandBtn && expandBtn.classList && expandBtn.classList.contains('expand-btn')) {
            expandBtn.style.display = 'none';
          }
        }
      }
    } catch (e) {
      console.error('[DCH] delegated click error:', e);
    }
  }, false);

  // ---------- UI helpers ----------
  function addUserMessage(m){
    var chat = byId('chatContainer'); if (!chat) return;
    var item = document.createElement('div'); item.className='conversation-item';
    var u = document.createElement('div'); u.className='user-message';
    var av = document.createElement('div'); av.className='user-avatar'; av.textContent=currentAvatarText;
    var msg = document.createElement('div');
    var name = document.createElement('div'); name.className='user-name';
    name.textContent = currentUser.displayName || currentUser.username || 'User';
    var txt = document.createElement('div'); txt.className='user-message-content'; txt.textContent=m;
    msg.appendChild(name); msg.appendChild(txt); u.appendChild(av); u.appendChild(msg);
    item.appendChild(u); chat.appendChild(item); chat.scrollTop = chat.scrollHeight;
  }

  function clearInput(){
    var input = byId('inputField'); if (input){ input.value=''; input.style.height='auto'; }
  }

  function setButtonsEnabled(enabled) {
    var ask = byId('askBtn');
    var submit = byId('submitBtn');
    if (ask) {
      if (enabled && !isLoading) { ask.removeAttribute('disabled'); ask.textContent = 'Ask'; ask.classList.remove('loading'); }
      else { ask.setAttribute('disabled', 'true'); ask.textContent = isLoading ? '⏳' : 'Ask'; if (isLoading) ask.classList.add('loading'); }
    }
    if (submit) {
      if (enabled && !isLoading) { submit.removeAttribute('disabled'); submit.textContent = '▶'; submit.classList.remove('loading'); }
      else { submit.setAttribute('disabled', 'true'); submit.textContent = isLoading ? '⏳' : '▶'; if (isLoading) submit.classList.add('loading'); }
    }
  }

  var busyToastVisible = false;
  function showBusyMessage(message) {
    if (busyToastVisible) return;
    busyToastVisible = true;
    var toast = document.createElement('div');
    toast.className = 'toast warning';
    toast.innerHTML = '<div style="display:flex;align-items:center;gap:8px;"><span>⚠️</span><span>' + message + '</span></div>';
    document.body.appendChild(toast);
    setTimeout(function(){
      toast.style.animation='slideOut .3s ease-in forwards';
      setTimeout(function(){ toast.remove(); busyToastVisible = false; }, 300);
    }, 2000);
  }

  function setLoadingState(loading) { isLoading = loading; setButtonsEnabled(!loading); }

  function handleSend(){
    try {
      console.log('[DCH] handleSend called');
      var input = byId('inputField'); if (!input) return;
      var text = (input.value || '').trim();

      if (!text) {
        var toast = document.createElement('div');
        toast.className = 'toast warning';
        toast.textContent = 'Type something first 🙂';
        document.body.appendChild(toast);
        setTimeout(function(){
          toast.style.animation='slideOut .3s ease-in forwards';
          setTimeout(function(){ toast.remove(); }, 300);
        }, 1200);
        return;
      }

      if (isLoading) return;

      addUserMessage(text);

      // ⬇️ Always send to backend — server will do regex + HF NLU
      isLoading = true; 
      setButtonsEnabled(false);
      clearInput();
      if (window.vscode) window.vscode.postMessage({ command: 'sendDevCommand', text: text });
    } catch (e) {
      console.error('[DCH] handleSend error:', e);
    }
  }

  // ---------- Bootstrap ----------
  function init(){
    try {
      var input  = byId('inputField');
      var ask    = byId('askBtn');
      var submit = byId('submitBtn');
      if (!input || !ask || !submit) {
        console.error('[DCH] missing UI elements', { hasInput: !!input, hasAsk: !!ask, hasSubmit: !!submit });
        return;
      }

      setButtonsEnabled(true);

      function autosize(){ input.style.height='auto'; input.style.height=Math.min(input.scrollHeight,120)+'px'; }
      input.addEventListener('input', autosize); autosize();

      ask.addEventListener('click', function(){ handleSend(); });
      submit.addEventListener('click', function(){ handleSend(); });

      input.addEventListener('keydown', function(e){
        if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSend(); }
      });

      if (window.vscode) window.vscode.postMessage({ command: 'requestUserInfo' });

      console.log('[DCH] controller: bound');
    } catch (e) {
      console.error('[DCH] init error:', e);
    }
  }

  if (document.readyState === 'loading') { document.addEventListener('DOMContentLoaded', init); }
  else { init(); }

  // ---------- Host messages ----------
  var typing = null;
  window.addEventListener('message', function(ev){
    try {
      var m = ev.data || {};
      if (m.command === 'showTyping') return showTyping();
      if (m.command === 'addDevResponse') { hideTyping(); return addDevResponse(m.response); }
      if (m.command === 'updateJobStatus') return updateJobStatusInChat(m.jobId, m.status, m.output, m.error_message, m.original_command);
      if (m.command === 'setLoadingState') return setLoadingState(m.loading);
      if (m.command === 'showPollingError') return showPollingError(m.jobId, m.message);
      if (m.command === 'showBusyMessage') return showBusyMessage(m.message);
      if (m.command === 'updateUserInfo') return updateUserInfo(m.user, m.avatarText);
      if (m.command === 'settingsChanged') { /* future banner toggle hook */ }
    } catch (e) {
      console.error('[DCH] message handler error:', e);
    }
  });

  function updateUserInfo(user, avatarText) {
    if (user) { currentUser = user; currentAvatarText = avatarText || 'D'; }
  }

  function showTyping(){
    var cc = byId('chatContainer'); if (!cc) return;
    if (typing) return;
    typing = document.createElement('div'); typing.className='conversation-item';
    typing.innerHTML = '<div class="bot-response"><div class="copilot-header"><div class="copilot-icon">⚡</div><div class="copilot-label">DevCommandHub</div><div class="copilot-meta">Processing...</div></div><div class="bot-message-content"><em>Processing your command...</em></div></div>';
    cc.appendChild(typing); cc.scrollTop = cc.scrollHeight;
  }
  function hideTyping(){ if (typing){ typing.remove(); typing=null; } }

  function showPollingError(jobId, message) {
    var el = document.querySelector('[data-job-id="' + jobId + '"]');
    if (!el) return;
    var errorDiv = document.createElement('div');
    errorDiv.className = 'polling-error';
    errorDiv.innerHTML = '<br><div class="error-banner">⚠️ ' + message + ' <button class="retry-polling-btn" data-job-id="' + jobId + '">Retry</button></div>';
    el.appendChild(errorDiv);
  }

  // ---------- Chat items ----------
  function addDevResponse(resp){
    var cc = byId('chatContainer'); if (!cc) return;

    var item = document.createElement('div');
    item.className = 'conversation-item';
    if (resp && resp.job_id) item.setAttribute('data-job-id', resp.job_id);

    var bot = document.createElement('div'); bot.className='bot-response';
    var head = document.createElement('div'); head.className='copilot-header';
    var icon = document.createElement('div'); icon.className='copilot-icon'; icon.textContent='⚡';
    var label = document.createElement('div'); label.className='copilot-label'; label.textContent='DevCommandHub';
    var meta = document.createElement('div'); meta.className='copilot-meta';
    var body = document.createElement('div'); body.className='bot-message-content';

    if (resp && resp.type === 'job_created') {
      meta.innerHTML = '<span class="status-badge ' + resp.status + '">' + resp.status + '</span>';
      var conf = (resp.parsed_intent && typeof resp.parsed_intent.confidence === 'number')
        ? (resp.parsed_intent.confidence * 100).toFixed(1) + '%'
        : '—';
      var source = (resp.parsed_intent && resp.parsed_intent.source) || '';
      var usingAI = (typeof source === 'string') && source.indexOf('hf:') === 0; // NEW
      var sourceBadge = usingAI ? '✅ AI parsing' : '⚠️ regex-only';

      body.innerHTML =
        '<strong>Command:</strong> ' + (resp.original_command || 'Unknown') + '<br>' +
        '<strong>Action:</strong> ' + (resp.parsed_intent && resp.parsed_intent.action || 'Unknown') + '<br>' +
        (resp.parsed_intent && resp.parsed_intent.service ? '<strong>Service:</strong> ' + resp.parsed_intent.service + '<br>' : '') +
        (resp.parsed_intent && resp.parsed_intent.environment ? '<strong>Environment:</strong> ' + resp.parsed_intent.environment + '<br>' : '') +
        '<strong>Confidence:</strong> ' + conf + '<br>' +
        '<strong>Parser:</strong> ' + sourceBadge + (source ? ' <span style="opacity:.6">(' + source + ')</span>' : '') + '<br>' + // NEW
        (resp.parsed_intent && typeof resp.parsed_intent.replicas !== 'undefined'
          ? '<strong>Replicas:</strong> ' + resp.parsed_intent.replicas + '<br>'
          : '') +
        '<strong>Created:</strong> ' + new Date(resp.created_at).toLocaleString() + '<br>' +
        '<div style="margin-top:8px;"><button class="action-btn refresh-btn" id="refresh-' + resp.job_id + '">🔄 Refresh</button></div>';

      body.setAttribute('data-job-id', resp.job_id || '');
      body.setAttribute('data-original-command', resp.original_command || '');

      setTimeout(function(){
        var btn = document.getElementById('refresh-' + resp.job_id);
        if (btn) btn.addEventListener('click', function(){
          if (window.vscode) window.vscode.postMessage({ command: 'refreshJob', jobId: resp.job_id });
        });
      }, 0);

    } else if (resp && resp.type === 'error') {
      meta.textContent = 'Error';
      body.className = 'bot-message-content error-message';
      body.textContent = resp.message || 'Unknown error';
      if (resp.show_retry && resp.original_command) {
        var retryBtn = document.createElement('button');
        retryBtn.className = 'action-btn retry-btn';
        retryBtn.textContent = '🔄 Retry';
        retryBtn.onclick = function(){
          if (window.vscode) window.vscode.postMessage({ command: 'retryJob', originalCommand: resp.original_command });
        };
        body.appendChild(document.createElement('br'));
        body.appendChild(retryBtn);
      }
    }

    head.appendChild(icon); head.appendChild(label); head.appendChild(meta);
    bot.appendChild(head); bot.appendChild(body);
    item.appendChild(bot);
    cc.appendChild(item);
    cc.scrollTop = cc.scrollHeight;
  }

  function updateJobStatusInChat(jobId, status, output, errorMessage, originalCommand) {
    var item = document.querySelector('[data-job-id="' + jobId + '"]');
    if (!item) return;

    var badge = item.querySelector('.status-badge');
    if (badge) { badge.textContent = status; badge.className = 'status-badge ' + status; }

    var content = item.querySelector('.bot-message-content');
    if (!content) return;

    content.querySelectorAll('.output-section, .error-section, .retry-section').forEach(function(n){ n.remove(); });

    if (output && output.length) {
      var o = document.createElement('div');
      o.className = 'output-section';
      o.innerHTML = '<strong>Output:</strong>' + createCollapsibleOutput(output, 'Output', 'output');
      content.appendChild(o);
    }

    if (errorMessage) {
      var er = document.createElement('div');
      er.className = 'error-section';
      er.innerHTML = '<strong>Error:</strong>' + createCollapsibleOutput(errorMessage, 'Error', 'error');
      content.appendChild(er);
    }

    // ---- replicas mismatch banner (optional but helpful)
    var desired = (function(){
      var wanted = item.querySelector('.bot-message-content');
      if (!wanted) return null;
      var m = wanted.innerHTML.match(/<strong>Replicas:<\\/strong>\\s*(\\d+)/i);
      return m ? Number(m[1]) : null;
    })();

    var actual = null;
    if (output && output.length) {
      var joined = Array.isArray(output) ? output.join('\\n') : String(output);
      var m2 = joined.match(/(?:scaled?|back(?:\\s+down)?)\\s+(?:to\\s+)?(\\d+)\\s+replicas?/i);
      if (m2) actual = Number(m2[1]);
    }

    if (desired != null && actual != null && desired !== actual) {
      var warn = document.createElement('div');
      warn.className = 'error-banner';
      warn.innerHTML = '⚠️ Requested ' + desired + ' replicas but executor reports ' + actual + '.';
      content.prepend(warn);
    }

    if (status === 'failed' && originalCommand) {
      var r = document.createElement('div');
      r.className = 'retry-section';
      r.innerHTML = '<button class="action-btn retry-btn" data-command="' + originalCommand + '">🔄 Retry Job</button>';
      var btn = r.querySelector('.retry-btn');
      if (btn) btn.addEventListener('click', function(){
        var cmd = this.getAttribute('data-command');
        if (cmd && window.vscode) window.vscode.postMessage({ command:'retryJob', originalCommand: cmd });
      });
      content.appendChild(r);
    }
  }

})(); 
</script>
`;
  }
}

// ---- QuickPick for API base URL ----
async function showApiBaseQuickPick() {
  const currentApiBase = vscode.workspace.getConfiguration('devcommandhub').get<string>('apiBaseUrl', 'http://localhost:3001');

  const quickPickItems = API_ENVIRONMENTS.map(env => ({
    label: env.label,
    description: env.description,
    detail: env.url === currentApiBase ? '$(check) Currently selected' : '',
    env
  }));

  const selected = await vscode.window.showQuickPick(quickPickItems, {
    placeHolder: 'Select API environment',
    title: 'DevCommandHub: Set API Base URL'
  });
  if (!selected) { return; }

  let newApiBase: string;
  if (selected.env.url === 'custom') {
    const customUrl = await vscode.window.showInputBox({
      prompt: 'Enter custom API base URL',
      value: currentApiBase,
      validateInput: (value) => {
        if (!value.trim()) { return 'API base URL cannot be empty'; }
        if (!/^https?:\/\//.test(value)) { return 'URL must start with http:// or https://'; }
        return null;
      }
    });
    if (!customUrl) { return; }
    newApiBase = customUrl.trim();
  } else {
    newApiBase = selected.env.url;
  }

  try {
    await vscode.workspace.getConfiguration('devcommandhub').update('apiBaseUrl', newApiBase, vscode.ConfigurationTarget.Global);
    vscode.window.showInformationMessage(`DevCommandHub API base updated to: ${newApiBase}`);
    console.log(`[DCH] API base URL updated to: ${newApiBase}`);
  } catch (error) {
    vscode.window.showErrorMessage(`Failed to update API base URL: ${error}`);
    console.error('[DCH] Error updating API base URL:', error);
  }
}

// ---- Extension entrypoints ----
export function activate(context: vscode.ExtensionContext) {
  const provider = new DevCommandHubProvider(context);
  context.subscriptions.push(
    vscode.commands.registerCommand('devcommandhub.openWindow', () => provider.openWindow()),
    vscode.commands.registerCommand('devcommandhub.setApiBase', showApiBaseQuickPick),
    provider
  );
}

export function deactivate() {}