// src/extension.ts - Day 7 Updates (Fixed)
import fetch from 'node-fetch';
import * as vscode from 'vscode';
import * as fs from 'fs';

// Add interface for user info
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

class DevCommandHubProvider implements vscode.Disposable {
  private panel?: vscode.WebviewPanel;
  private pollingJobs = new Set<string>();
  private isProcessingCommand = false;
  private currentJobId: string | null = null;
  private currentUser: VSCodeUser | null = null;

  constructor(private context: vscode.ExtensionContext) {
    this.initializeUser();
  }

  dispose() {
    if (this.panel) {
      this.panel.dispose();
      this.panel = undefined;
    }
    this.pollingJobs.clear();
    this.isProcessingCommand = false;
    this.currentJobId = null;
  }

  // Day 7: Get real VS Code user information
  private async initializeUser() {
    try {
      // Try multiple methods to get user info
      let username: string;
      try {
        // Use OS user info as fallback
        const os = await import('os');
        username = os.userInfo().username || 'developer';
      } catch {
        username = 'developer';
      }
      let email: string | undefined;
      let displayName: string | undefined;

      // Try to get Git user info as fallback
      try {
        const gitConfig = vscode.workspace.getConfiguration('git');
        email = gitConfig.get<string>('userEmail');
        displayName = gitConfig.get<string>('userName');
      } catch (gitError) {
        console.log('[DCH] Could not get Git user info:', gitError);
      }

      this.currentUser = {
        username,
        email,
        displayName: displayName || username
      };

      console.log('[DCH] User initialized:', this.currentUser);
    } catch (error) {
      console.warn('[DCH] Failed to initialize user, using fallback:', error);
      this.currentUser = {
        username: 'developer',
        displayName: 'Developer'
      };
    }
  }

  // Day 7: Get user avatar initials
  private getUserAvatarText(): string {
    if (!this.currentUser) {return 'D';}
    
    const displayName = this.currentUser.displayName || this.currentUser.username;
    if (displayName.includes(' ')) {
      // Get first letters of first and last name
      const parts = displayName.split(' ');
      return (parts[0][0] + (parts[parts.length - 1][0] || '')).toUpperCase();
    }
    
    // Get first two letters of username/displayName
    return displayName.substring(0, 2).toUpperCase();
  }

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

    const htmlPath = vscode.Uri.joinPath(this.context.extensionUri, 'media.html');
    let html = fs.readFileSync(htmlPath.fsPath, 'utf-8');

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

    const vscodeBoot =
      `<script nonce="${nonce}">console.log('[DCH] boot');try{window.vscode=acquireVsCodeApi();}catch(e){console.warn('acquireVsCodeApi unavailable',e);}</script>`;

    const controller = this.getControllerScript(nonce);

    const endIdx = html.toLowerCase().lastIndexOf('</body>');
    if (endIdx >= 0) {html = html.slice(0, endIdx) + `\n${vscodeBoot}\n${controller}\n` + html.slice(endIdx);}
    else {html += `\n${vscodeBoot}\n${controller}\n`;}

    this.panel.webview.html = html;

    this.panel.webview.onDidReceiveMessage(async (message) => {
      switch (message.command) {
        case 'sendDevCommand':
          await this.handleDevCommand(message.text);
          break;
        case 'refreshJob':
          if (message.jobId) {await this.refreshJobStatus(message.jobId);}
          break;
        case 'retryJob':
          if (!message.originalCommand) {break;}
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
          // Day 7: Send current user info to webview
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

    // Day 7: Send user info immediately after panel creation
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

  private async handleDevCommand(command: string) {
    if (!this.panel) {return;}

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
      if (!response.success) {throw new Error('Failed to create job');}

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
      if (sel === 'Retry') {console.log('[DCH] User selected retry from error toast');}
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
            if (this.panel) {this.panel.webview.postMessage({ command: 'setLoadingState', loading: false });}
          }
          return;
        }

        if (attempts >= maxAttempts) {
          console.log(`[DCH] Max polling attempts reached for job ${jobId}`);
          this.pollingJobs.delete(jobId);

          if (this.currentJobId === jobId) {
            this.currentJobId = null;
            this.isProcessingCommand = false;
            if (this.panel) {this.panel.webview.postMessage({ command: 'setLoadingState', loading: false });}
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

  private async sendCommandToAPI(command: string): Promise<JobResponse> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 30000);
    try {
      const resp = await fetch(`${this.getApiBaseUrl()}/api/commands`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ command }),
        signal: controller.signal
      });
      clearTimeout(timeoutId);
      if (!resp.ok) {throw new Error(`API request failed: ${resp.status} ${resp.statusText}`);}
      return (await resp.json()) as JobResponse;
    } catch (error) {
      clearTimeout(timeoutId);
      if (typeof error === 'object' && error && 'name' in error && (error as any).name === 'AbortError') {
        throw new Error('Request timed out after 30 seconds');
      }
      throw error;
    }
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
        error_message: job.error_message,
        original_command: job.original_command
      });
    } catch (e) {
      vscode.window.showErrorMessage(`Failed to refresh job: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  private async getJobDetails(jobId: string): Promise<JobDetails> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 15000);
    try {
      const resp = await fetch(`${this.getApiBaseUrl()}/api/jobs/${jobId}`, { signal: controller.signal });
      clearTimeout(timeoutId);
      if (!resp.ok) {throw new Error(`Failed to fetch job details: ${resp.status} ${resp.statusText}`);}
      const result = (await resp.json()) as { job: JobDetails };
      return result.job;
    } catch (error) {
      clearTimeout(timeoutId);
      if (typeof error === 'object' && error && 'name' in error && (error as any).name === 'AbortError') {
        throw new Error('Job status request timed out');
      }
      throw error;
    }
  }

  // Day 7: Enhanced controller script with output formatting and dynamic username
  private getControllerScript(nonce: string): string {
    return `
<script nonce="${nonce}">
(function() {
  console.log('[DCH] controller: start');

  var vscode = window.vscode || (typeof acquireVsCodeApi === 'function' ? acquireVsCodeApi() : null);
  window.vscode = vscode;

  // Day 7: User state
  var currentUser = { username: 'developer', displayName: 'Developer' };
  var currentAvatarText = 'D';

  function byId(id){ return document.getElementById(id); }
  var DEVOPS = ['deploy','scale','logs','restart','rollback','status'];
  function isDevOps(txt){ txt=(txt||'').toLowerCase(); return DEVOPS.some(function(k){ return txt.indexOf(k) !== -1; }); }

  var isLoading = false;

  // Day 7: Enhanced syntax highlighting
  function highlightCode(text) {
    if (!text) return '';
    
    // Detect log types and apply appropriate highlighting
    return text
      // JSON highlighting
      .replace(/(\\{[^}]*\\}|\\[[^\\]]*\\])/g, '<span class="syntax-json">$1</span>')
      // Error patterns
      .replace(/(ERROR|FATAL|FAIL|Exception|Error:)/gi, '<span class="syntax-error">$1</span>')
      // Warning patterns  
      .replace(/(WARN|WARNING|DEPRECATED)/gi, '<span class="syntax-warning">$1</span>')
      // Success patterns
      .replace(/(SUCCESS|OK|COMPLETE|DONE|✓)/gi, '<span class="syntax-success">$1</span>')
      // Info patterns
      .replace(/(INFO|DEBUG|LOG)/gi, '<span class="syntax-info">$1</span>')
      // URLs
      .replace(/(https?:\\/\\/[^\\s]+)/g, '<span class="syntax-url">$1</span>')
      // Kubernetes patterns
      .replace(/(pod|service|deployment|namespace)/gi, '<span class="syntax-k8s">$1</span>')
      // File paths
      .replace(/(\\/[^\\s]*\\.[^\\s]*)/g, '<span class="syntax-path">$1</span>')
      // Numbers
      .replace(/\\b(\\d+)\\b/g, '<span class="syntax-number">$1</span>');
  }

  // Day 7: Collapsible output formatter
  function createCollapsibleOutput(content, title, type) {
    if (!content || (Array.isArray(content) && content.length === 0)) return '';
    
    var text = Array.isArray(content) ? content.join('\\n') : content;
    var lines = text.split('\\n');
    var isLongOutput = lines.length > 10 || text.length > 1000;
    
    var id = 'collapse-' + Math.random().toString(36).substr(2, 9);
    var typeClass = type === 'error' ? 'error-content' : 'output-content';
    
    if (!isLongOutput) {
      // Short content - show directly with syntax highlighting
      return '<div class="code-block ' + typeClass + '">' + highlightCode(text) + '</div>';
    }
    
    // Long content - make collapsible
    var preview = lines.slice(0, 5).join('\\n');
    var remaining = lines.slice(5).join('\\n');
    var remainingLines = lines.length - 5;
    
    return '<div class="collapsible-output">' +
             '<div class="code-block ' + typeClass + '">' + 
               highlightCode(preview) + 
               '<div class="output-preview-fade"></div>' +
             '</div>' +
             '<button class="expand-btn" onclick="toggleOutput(\\'' + id + '\\', this)">' +
               '▶ Show ' + remainingLines + ' more lines' +
             '</button>' +
             '<div id="' + id + '" class="collapsed-content" style="display: none;">' +
               '<div class="code-block ' + typeClass + '">' + highlightCode(remaining) + '</div>' +
               '<button class="collapse-btn" onclick="toggleOutput(\\'' + id + '\\', this)">▲ Show less</button>' +
             '</div>' +
           '</div>';
  }

  // Global function for collapsible toggle
  window.toggleOutput = function(id, btn) {
    var content = document.getElementById(id);
    var isExpanded = content.style.display !== 'none';
    
    if (isExpanded) {
      content.style.display = 'none';
      var expandBtn = content.previousElementSibling;
      if (expandBtn && expandBtn.className === 'expand-btn') {
        expandBtn.style.display = 'block';
      }
    } else {
      content.style.display = 'block';
      var expandBtn = content.previousElementSibling;
      if (expandBtn && expandBtn.className === 'expand-btn') {
        expandBtn.style.display = 'none';
      }
    }
  };

  function addUserMessage(m){
    var chat = byId('chatContainer'); if (!chat) return;
    var item = document.createElement('div'); item.className='conversation-item';
    var u = document.createElement('div'); u.className='user-message';
    var av = document.createElement('div'); av.className='user-avatar'; av.textContent=currentAvatarText;
    var msg = document.createElement('div');
    var name = document.createElement('div'); name.className='user-name'; name.textContent=currentUser.displayName;
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

  // Add the missing addDevResponse function
  function addDevResponse(response) {
    var chat = byId('chatContainer'); if (!chat) return;
    
    var item = document.createElement('div'); 
    item.className = 'conversation-item';
    item.setAttribute('data-job-id', response.job_id || '');
    
    var botDiv = document.createElement('div'); 
    botDiv.className = 'bot-response';
    
    var head = document.createElement('div'); 
    head.className = 'copilot-header';
    
    var icon = document.createElement('div'); 
    icon.className = 'copilot-icon'; 
    icon.textContent = '⚡';
    
    var label = document.createElement('div'); 
    label.className = 'copilot-label'; 
    label.textContent = 'DevCommandHub';
    
    var meta = document.createElement('div'); 
    meta.className = 'copilot-meta';
    
    if (response.type === 'error') {
      meta.textContent = 'Error';
      var body = document.createElement('div'); 
      body.className = 'bot-message-content error-message';
      body.textContent = response.message;
      
      if (response.show_retry && response.original_command) {
        var retryBtn = document.createElement('button');
        retryBtn.className = 'action-btn retry-btn';
        retryBtn.textContent = '🔄 Retry';
        retryBtn.onclick = function() {
          if (vscode) {
            vscode.postMessage({
              command: 'retryJob',
              originalCommand: response.original_command
            });
          }
        };
        body.appendChild(retryBtn);
      }
    } else {
      // Job created
      meta.innerHTML = '<span class="status-badge ' + response.status + '">' + response.status + '</span>';
      
      var body = document.createElement('div'); 
      body.className = 'bot-message-content';
      
      var commandDiv = document.createElement('div');
      commandDiv.innerHTML = '<strong>Command:</strong> ' + (response.original_command || 'Unknown');
      
      var actionDiv = document.createElement('div');
      actionDiv.innerHTML = '<strong>Action:</strong> ' + (response.parsed_intent?.action || 'Unknown');
      
      body.appendChild(commandDiv);
      body.appendChild(actionDiv);
      
      // Add action buttons
      var actionsDiv = document.createElement('div');
      actionsDiv.style.marginTop = '8px';
      
      var refreshBtn = document.createElement('button');
      refreshBtn.className = 'action-btn refresh-btn';
      refreshBtn.textContent = '🔄 Refresh';
      refreshBtn.onclick = function() {
        if (vscode && response.job_id) {
          vscode.postMessage({
            command: 'refreshJob',
            jobId: response.job_id
          });
        }
      };
      
      actionsDiv.appendChild(refreshBtn);
      body.appendChild(actionsDiv);
    }
    
    head.appendChild(icon); 
    head.appendChild(label); 
    head.appendChild(meta);
    botDiv.appendChild(head); 
    botDiv.appendChild(body);
    item.appendChild(botDiv);
    
    chat.appendChild(item); 
    chat.scrollTop = chat.scrollHeight;
  }

  // Add the missing updateJobStatusInChat function
  function updateJobStatusInChat(jobId, status, output, errorMessage, originalCommand) {
    var item = document.querySelector('[data-job-id="' + jobId + '"]');
    if (!item) return;
    
    var statusBadge = item.querySelector('.status-badge');
    if (statusBadge) {
      statusBadge.className = 'status-badge ' + status;
      statusBadge.textContent = status;
    }
    
    var content = item.querySelector('.bot-message-content');
    if (!content) return;
    
    // Remove existing output/error sections
    var existing = content.querySelectorAll('.output-section, .error-section');
    existing.forEach(function(el) { el.remove(); });
    
    // Add output if present
    if (output && output.length > 0) {
      var outputSection = document.createElement('div');
      outputSection.className = 'output-section';
      outputSection.innerHTML = '<strong>Output:</strong>';
      outputSection.innerHTML += createCollapsibleOutput(output, 'Output', 'output');
      content.appendChild(outputSection);
    }
    
    // Add error if present
    if (errorMessage) {
      var errorSection = document.createElement('div');
      errorSection.className = 'error-section';
      errorSection.innerHTML = '<strong>Error:</strong>';
      errorSection.innerHTML += createCollapsibleOutput(errorMessage, 'Error', 'error');
      content.appendChild(errorSection);
    }
  }

  function clearInput(){
    var input = byId('inputField'); if (input){ input.value=''; input.style.height='auto'; }
  }

  function setButtonsEnabled(enabled) {
    var ask = byId('askBtn');
    var submit = byId('submitBtn');
    if (ask) {
      if (enabled && !isLoading) {
        ask.removeAttribute('disabled'); ask.textContent = 'Ask'; ask.classList.remove('loading');
      } else {
        ask.setAttribute('disabled', 'true'); ask.textContent = isLoading ? '⏳' : 'Ask'; if (isLoading) ask.classList.add('loading');
      }
    }
    if (submit) {
      if (enabled && !isLoading) {
        submit.removeAttribute('disabled'); submit.textContent = '▶'; submit.classList.remove('loading');
      } else {
        submit.setAttribute('disabled', 'true'); submit.textContent = isLoading ? '⏳' : '▶'; if (isLoading) submit.classList.add('loading');
      }
    }
  }

  // Dedup warning toast if user spams while locked
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

  function setLoadingState(loading) {
    isLoading = loading;
    setButtonsEnabled(!loading);
    console.log('[DCH] Loading state:', loading);
  }

  function handleSend(){
    var input = byId('inputField'); if (!input) return;
    var text = (input.value||'').trim(); if (!text) return;

    // Optimistic lock: block double-send
    if (isLoading) {
      console.log('[DCH] Request in progress, ignoring send');
      return;
    }

    addUserMessage(text);

    if (isDevOps(text)) {
      // Lock for DevOps jobs
      isLoading = true;
      setButtonsEnabled(false);

      clearInput();
      if (window.vscode) {
        window.vscode.postMessage({ command: 'sendDevCommand', text: text });
      }
      return;
    }

    // Demo path
    clearInput();
    addDemoBotReply();
    isLoading = false;
    setButtonsEnabled(true);
  }

  function init(){
    var input  = byId('inputField');
    var ask    = byId('askBtn');
    var submit = byId('submitBtn');
    if (!input || !ask || !submit) { console.error('[DCH] missing UI elements'); return; }

    setButtonsEnabled(true);

    function autosize(){ input.style.height='auto'; input.style.height=Math.min(input.scrollHeight,120)+'px'; }
    input.addEventListener('input', autosize); autosize();

    ask.addEventListener('click', handleSend);
    submit.addEventListener('click', handleSend);
    input.addEventListener('keydown', function(e){ if (e.key==='Enter' && !e.shiftKey){ e.preventDefault(); handleSend(); }});
    input.focus();
    
    // Day 7: Request user info on init
    if (window.vscode) {
      window.vscode.postMessage({ command: 'requestUserInfo' });
    }
    
    console.log('[DCH] controller: bound');
  }

  if (document.readyState==='loading') document.addEventListener('DOMContentLoaded', init);
  else init();

  var typing = null;
  window.addEventListener('message', function(ev){
    var m = ev.data || {};
    if (m.command === 'showTyping') return showTyping();
    if (m.command === 'addDevResponse') { hideTyping(); return addDevResponse(m.response); }
    if (m.command === 'updateJobStatus') return updateJobStatusInChat(m.jobId, m.status, m.output, m.error_message, m.original_command);
    if (m.command === 'setLoadingState') return setLoadingState(m.loading);
    if (m.command === 'showPollingError') return showPollingError(m.jobId, m.message);
    if (m.command === 'showBusyMessage') return showBusyMessage(m.message);
    if (m.command === 'updateUserInfo') return updateUserInfo(m.user, m.avatarText); // Day 7
  });

  // Day 7: Update user info
  function updateUserInfo(user, avatarText) {
    if (user) {
      currentUser = user;
      currentAvatarText = avatarText || 'D';
      console.log('[DCH] User info updated:', user);
    }
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

})(); 
</script>
`;
  } // <-- Close getControllerScript method

} // <-- Close DevCommandHubProvider class