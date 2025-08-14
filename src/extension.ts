// src/extension.ts
import * as vscode from 'vscode';
import * as fs from 'fs';

interface JobResponse {
  success: boolean;
  job_id: string;
  parsed_intent: {
    action: string;
    service?: string;
    environment?: string;
    confidence: number;
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

class DevCommandHubProvider {
  private panel?: vscode.WebviewPanel;

  constructor(private context: vscode.ExtensionContext) {}

  private getApiBaseUrl(): string {
    return vscode.workspace.getConfiguration('devcommandhub').get('apiBaseUrl', 'http://localhost:3001');
  }

  private getNonce(): string {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    let s = '';
    for (let i = 0; i < 32; i++) {s += chars[Math.floor(Math.random() * chars.length)];}
    return s;
  }

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

  // Load media.html from the extension root
  const htmlPath = vscode.Uri.joinPath(this.context.extensionUri, 'media.html');
  let html = fs.readFileSync(htmlPath.fsPath, 'utf-8');

  // Ensure Ask/Submit are not visually disabled even if our script hasn't run yet
  html = html
    .replace(/(<button[^>]*id="askBtn"[^>]*)(\sdisabled)?/i, '$1')
    .replace(/(<button[^>]*id="submitBtn"[^>]*)(\sdisabled)?/i, '$1');

  // CSP + nonce
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

  const vscodeBoot =
    `<script nonce="${nonce}">console.log('[DCH] boot');try{window.vscode=acquireVsCodeApi();}catch(e){console.warn('acquireVsCodeApi unavailable',e);}</script>`;

  const controller = this.getControllerScript(nonce);

  // Append boot + controller at the *actual* end of body (fallback if missing)
  const endIdx = html.toLowerCase().lastIndexOf('</body>');
  if (endIdx >= 0) {
    html = html.slice(0, endIdx) + `\n${vscodeBoot}\n${controller}\n` + html.slice(endIdx);
  } else {
    html += `\n${vscodeBoot}\n${controller}\n`;
  }

  this.panel.webview.html = html;

  this.panel.webview.onDidReceiveMessage(async (message) => {
    switch (message.command) {
      case 'sendDevCommand':
        await this.handleDevCommand(message.text);
        break;
      case 'refreshJob':
        if (message.jobId) {await this.refreshJobStatus(message.jobId);}
        break;
    }
  }, undefined, this.context.subscriptions);

  this.panel.onDidDispose(() => (this.panel = undefined), null, this.context.subscriptions);
}


  private async handleDevCommand(command: string) {
    if (!this.panel) {return;}
    try {
      this.panel.webview.postMessage({ command: 'showTyping' });
      const response = await this.sendCommandToAPI(command);
      if (response.success) {
        this.panel.webview.postMessage({
          command: 'addDevResponse',
          response: {
            type: 'job_created',
            job_id: response.job_id,
            parsed_intent: response.parsed_intent,
            status: response.status,
            created_at: response.created_at
          }
        });
      } else {
        throw new Error('Failed to create job');
      }
    } catch (error) {
      this.panel.webview.postMessage({
        command: 'addDevResponse',
        response: {
          type: 'error',
          message: error instanceof Error ? error.message : 'Unknown error occurred'
        }
      });
    }
  }

  private async sendCommandToAPI(command: string): Promise<JobResponse> {
    const resp = await fetch(`${this.getApiBaseUrl()}/api/commands`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ command })
    });
    if (!resp.ok) {throw new Error(`API request failed: ${resp.status} ${resp.statusText}`);}
    return (await resp.json()) as JobResponse;
  }

  private async refreshJobStatus(jobId: string) {
    if (!this.panel) {return;}
    try {
      const job = await this.getJobDetails(jobId);
      this.panel.webview.postMessage({
        command: 'updateJobStatus',
        jobId,
        status: job.status,
        output: job.output,
        error_message: job.error_message
      });
    } catch (e) {
      vscode.window.showErrorMessage(`Failed to refresh job: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  private async getJobDetails(jobId: string): Promise<JobDetails> {
    const resp = await fetch(`${this.getApiBaseUrl()}/api/jobs/${jobId}`);
    if (!resp.ok) {throw new Error(`Failed to fetch job details: ${resp.status} ${resp.statusText}`);}
    const result = (await resp.json()) as { job: JobDetails };
    return result.job;
  }

  private getControllerScript(nonce: string): string {
  return `
<script nonce="${nonce}">
(function() {
  console.log('[DCH] controller: start');

  var vscode = window.vscode || (typeof acquireVsCodeApi === 'function' ? acquireVsCodeApi() : null);
  window.vscode = vscode;

  function byId(id){ return document.getElementById(id); }
  var DEVOPS = ['deploy','scale','logs','restart','rollback','status'];
  function isDevOps(txt){ txt=(txt||'').toLowerCase(); return DEVOPS.some(k => txt.includes(k)); }

  function addUserMessage(m){
    var chat = byId('chatContainer'); if (!chat) return;
    var item = document.createElement('div'); item.className='conversation-item';
    var u = document.createElement('div'); u.className='user-message';
    var av = document.createElement('div'); av.className='user-avatar'; av.textContent='A';
    var msg = document.createElement('div');
    var name = document.createElement('div'); name.className='user-name'; name.textContent='aaron-gheevarghese';
    var txt = document.createElement('div'); txt.className='user-message-content'; txt.textContent=m;
    msg.appendChild(name); msg.appendChild(txt); u.appendChild(av); u.appendChild(msg);
    item.appendChild(u); chat.appendChild(item); chat.scrollTop = chat.scrollHeight;
  }

  function addDemoBotReply(){
    var chat = byId('chatContainer'); if (!chat) return;
    var botDiv = document.createElement('div'); botDiv.className='bot-response';
    var head = document.createElement('div'); head.className='copilot-header';
    var icon = document.createElement('div'); icon.className='copilot-icon'; icon.textContent='⚡';
    var label = document.createElement('div'); label.className='copilot-label'; label.textContent='DevCommandHub';
    var meta = document.createElement('div'); meta.className='copilot-meta'; meta.textContent='Demo';
    head.appendChild(icon); head.appendChild(label); head.appendChild(meta);
    var body = document.createElement('div'); body.className='bot-message-content';
    body.textContent = "I'm a demo assistant. I can help you with coding questions, explain concepts, and assist with development tasks!";
    var wrap = document.createElement('div'); wrap.className='conversation-item';
    wrap.appendChild(botDiv); botDiv.appendChild(head); botDiv.appendChild(body);
    chat.appendChild(wrap); chat.scrollTop = chat.scrollHeight;
  }

  function clearInput(){
    var input = byId('inputField');
    if (input){ input.value=''; input.style.height='auto'; }
  }

  function handleSend(){
    var input = byId('inputField'); if (!input) return;
    var text = (input.value||'').trim(); if (!text) return;
    addUserMessage(text);

    if (isDevOps(text)) {
      console.log('[DCH] routing to backend:', text);
      clearInput();
      if (window.vscode) window.vscode.postMessage({ command: 'sendDevCommand', text: text });
      return;
    }
    clearInput();
    addDemoBotReply();
  }

  function init(){
    var input  = byId('inputField');
    var ask    = byId('askBtn');
    var submit = byId('submitBtn');
    if (!input || !ask || !submit) { console.error('[DCH] missing UI elements'); return; }

    // Force-enable and keep them enabled
    ask.removeAttribute('disabled'); submit.removeAttribute('disabled');
    setInterval(function(){
      if (ask.hasAttribute('disabled')) ask.removeAttribute('disabled');
      if (submit.hasAttribute('disabled')) submit.removeAttribute('disabled');
    }, 500);

    function autosize(){
      input.style.height = 'auto';
      input.style.height = Math.min(input.scrollHeight, 120) + 'px';
    }
    input.addEventListener('input', autosize); autosize();

    ask.addEventListener('click', handleSend);
    submit.addEventListener('click', handleSend);
    input.addEventListener('keydown', function(e){
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSend(); }
    });

    input.focus();
    console.log('[DCH] controller: bound');
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();

  // ===== extension → webview
  var typing = null;
  window.addEventListener('message', function(ev){
    var m = ev.data || {};
    if (m.command === 'showTyping') return showTyping();
    if (m.command === 'addDevResponse') { hideTyping(); return addDevResponse(m.response); }
    if (m.command === 'updateJobStatus') return updateJobStatusInChat(m.jobId, m.status, m.output, m.error_message);
  });

  function showTyping(){
    var cc = byId('chatContainer'); if (!cc) return;
    if (typing) return;
    typing = document.createElement('div'); typing.className='conversation-item';
    typing.innerHTML = '<div class="bot-response"><div class="copilot-header"><div class="copilot-icon">⚡</div><div class="copilot-label">DevCommandHub</div><div class="copilot-meta">Processing...</div></div><div class="bot-message-content"><em>Processing your command...</em></div></div>';
    cc.appendChild(typing); cc.scrollTop = cc.scrollHeight;
  }
  function hideTyping(){ if (typing){ typing.remove(); typing=null; } }

  function addDevResponse(resp){
    var cc = byId('chatContainer'); if (!cc) return;
    var bot = document.createElement('div'); bot.className = 'bot-response';
    var head = document.createElement('div'); head.className='copilot-header';
    var icon = document.createElement('div'); icon.className='copilot-icon'; icon.textContent='⚡';
    var label = document.createElement('div'); label.className='copilot-label'; label.textContent='DevCommandHub';
    var meta = document.createElement('div'); meta.className='copilot-meta';
    var body = document.createElement('div'); body.className='bot-message-content';

    if (resp && resp.type === 'job_created') {
      meta.textContent = 'Job Created';
      var conf = (resp.parsed_intent.confidence * 100).toFixed(1);
      body.innerHTML =
        '<strong>✅ Command processed successfully!</strong><br><br>' +
        '<strong>Job Details:</strong><br>' +
        '📋 Job ID: <code>' + resp.job_id + '</code><br>' +
        '🎯 Action: <strong>' + resp.parsed_intent.action + '</strong><br>' +
        (resp.parsed_intent.service ? '🔧 Service: <strong>' + resp.parsed_intent.service + '</strong><br>' : '') +
        (resp.parsed_intent.environment ? '🌍 Environment: <strong>' + resp.parsed_intent.environment + '</strong><br>' : '') +
        '📊 Confidence: <strong>' + conf + '%</strong><br>' +
        '📈 Status: <span class="status-badge ' + resp.status + '">' + resp.status + '</span><br>' +
        '🕒 Created: ' + new Date(resp.created_at).toLocaleString() + '<br><br>' +
        '<button id="refresh-' + resp.job_id + '" style="background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: none; padding: 6px 12px; border-radius: 3px; cursor: pointer;">🔄 Refresh Status</button>';
      body.setAttribute('data-job-id', resp.job_id);
      setTimeout(function(){
        var btn = document.getElementById('refresh-' + resp.job_id);
        if (btn) btn.addEventListener('click', function(){
          if (window.vscode) window.vscode.postMessage({ command: 'refreshJob', jobId: resp.job_id });
        });
      }, 0);
    } else if (resp && resp.type === 'error') {
      meta.textContent = 'Error';
      body.innerHTML = '<strong>❌ Error processing command:</strong><br>' + resp.message;
    }

    head.appendChild(icon); head.appendChild(label); head.appendChild(meta);
    bot.appendChild(head); bot.appendChild(body);

    var last = cc.lastElementChild;
    if (last && last.className === 'conversation-item') last.appendChild(bot);
    else { var wrap = document.createElement('div'); wrap.className='conversation-item'; wrap.appendChild(bot); cc.appendChild(wrap); }
    cc.scrollTop = cc.scrollHeight;
  }

  function updateJobStatusInChat(jobId, status, output, errorMessage){
    var el = document.querySelector('[data-job-id="' + jobId + '"]');
    if (!el) return;
    var badge = el.querySelector('.status-badge'); if (badge) { badge.textContent = status; badge.className = 'status-badge ' + status; }
    if (output && output.length){ var o=document.createElement('div'); o.innerHTML='<br><strong>📄 Output:</strong><div class="code-block">'+output.join('\\n')+'</div>'; el.appendChild(o); }
    if (errorMessage){ var er=document.createElement('div'); er.innerHTML='<br><strong>❌ Error:</strong><div class="code-block">'+errorMessage+'</div>'; el.appendChild(er); }
  }

  // Status badge styles
  var style = document.createElement('style');
  style.textContent =
    '.status-badge{display:inline-block;padding:2px 6px;border-radius:3px;font-size:.8em;font-weight:bold;text-transform:uppercase}' +
    '.status-badge.queued{background-color:#ffd700;color:#000}' +
    '.status-badge.running{background-color:#007acc;color:#fff}' +
    '.status-badge.completed{background-color:#28a745;color:#fff}' +
    '.status-badge.failed{background-color:#dc3545;color:#fff}' +
    '.status-badge.cancelled{background-color:#6c757d;color:#fff}';
  document.head.appendChild(style);

  console.log('[DCH] controller: ready');
})();
</script>
`;
}


  dispose() { if (this.panel) {this.panel.dispose();} }
}

export function activate(context: vscode.ExtensionContext) {
  const provider = new DevCommandHubProvider(context);
  context.subscriptions.push(
    vscode.commands.registerCommand('devcommandhub.openWindow', () => provider.openWindow()),
    provider
  );
}

export function deactivate() {}
