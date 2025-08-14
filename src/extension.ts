import * as vscode from 'vscode';
import * as path from 'path';
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

  async openWindow() {
    if (this.panel) {
      this.panel.reveal(vscode.ViewColumn.Beside);
      return;
    }

    this.panel = vscode.window.createWebviewPanel(
      'devcommandhub.panel',
      'DevCommandHub Panel',
      vscode.ViewColumn.Beside,
      { 
        enableScripts: true,
        retainContextWhenHidden: true
      }
    );

    // Load the HTML file
    const htmlPath = vscode.Uri.joinPath(this.context.extensionUri, 'media.html');
    let html = fs.readFileSync(htmlPath.fsPath, 'utf-8');

    // Inject our custom script to handle DevCommandHub functionality
    const customScript = this.getCustomScript();
    html = html.replace('</body>', `${customScript}</body>`);

    this.panel.webview.html = html;

    // Handle messages from webview
    this.panel.webview.onDidReceiveMessage(
      async (message) => {
        switch (message.command) {
          case 'sendCommand':
            await this.handleDevCommand(message.text);
            break;
          case 'refreshJob':
            if (message.jobId) {
              await this.refreshJobStatus(message.jobId);
            }
            break;
        }
      },
      undefined,
      this.context.subscriptions
    );

    this.panel.onDidDispose(() => {
      this.panel = undefined;
    }, null, this.context.subscriptions);

    vscode.window.showInformationMessage('DevCommandHub Panel Opened!');
  }

  private async handleDevCommand(command: string) {
    if (!this.panel) {
      return;
    }

    try {
      // Show typing indicator
      this.panel.webview.postMessage({
        command: 'showTyping'
      });

      // Send command to API
      const response = await this.sendCommandToAPI(command);

      if (response.success) {
        // Send successful response back to webview
        this.panel.webview.postMessage({
          command: 'addBotResponse',
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
      // Send error response
      this.panel.webview.postMessage({
        command: 'addBotResponse',
        response: {
          type: 'error',
          message: error instanceof Error ? error.message : 'Unknown error occurred'
        }
      });
    }
  }

  private async sendCommandToAPI(command: string): Promise<JobResponse> {
    const apiUrl = `${this.getApiBaseUrl()}/api/commands`;
    
    const response = await fetch(apiUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ command }),
    });

    if (!response.ok) {
      throw new Error(`API request failed: ${response.status} ${response.statusText}`);
    }

    return await response.json() as JobResponse;
  }

  private async refreshJobStatus(jobId: string) {
    if (!this.panel) {
      return;
    }

    try {
      const jobDetails = await this.getJobDetails(jobId);
      
      this.panel.webview.postMessage({
        command: 'updateJobStatus',
        jobId: jobId,
        status: jobDetails.status,
        output: jobDetails.output,
        error_message: jobDetails.error_message
      });
    } catch (error) {
      vscode.window.showErrorMessage(`Failed to refresh job: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private async getJobDetails(jobId: string): Promise<JobDetails> {
    const apiUrl = `${this.getApiBaseUrl()}/api/jobs/${jobId}`;
    
    const response = await fetch(apiUrl);
    
    if (!response.ok) {
      throw new Error(`Failed to fetch job details: ${response.status} ${response.statusText}`);
    }

    const result = await response.json() as { job: JobDetails };
    return result.job;
  }

  private getCustomScript(): string {
    return `
    <script>
      // Override the sendMessage function to handle DevCommandHub commands
      const originalSendMessage = window.sendMessage || function() {};
      
      window.sendMessage = function() {
        const text = inputField.value.trim();
        if (!text) return;

        // Check if this looks like a DevOps command
        const devOpsKeywords = ['deploy', 'scale', 'logs', 'restart', 'rollback', 'status'];
        const isDevOpsCommand = devOpsKeywords.some(keyword => 
          text.toLowerCase().includes(keyword)
        );

        if (isDevOpsCommand) {
          // Handle as DevCommandHub command
          addUserMessage(text);
          
          // Send to extension for API processing
          vscode.postMessage({
            command: 'sendCommand',
            text: text
          });
          
          // Clear input
          inputField.value = '';
          inputField.style.height = 'auto';
          askBtn.disabled = true;
          submitBtn.disabled = true;
        } else {
          // Handle as regular chat (existing functionality)
          addConversation(text);
          inputField.value = '';
          inputField.style.height = 'auto';
          askBtn.disabled = true;
          submitBtn.disabled = true;
        }
      };

      // Add user message without bot response (for DevOps commands)
      function addUserMessage(userMessage) {
        const conversationItem = document.createElement('div');
        conversationItem.className = 'conversation-item';

        const userDiv = document.createElement('div');
        userDiv.className = 'user-message';
        
        const avatar = document.createElement('div');
        avatar.className = 'user-avatar';
        avatar.textContent = 'A';
        
        const messageContent = document.createElement('div');
        const userName = document.createElement('div');
        userName.className = 'user-name';
        userName.textContent = 'aaron-gheevarghese';
        
        const userText = document.createElement('div');
        userText.className = 'user-message-content';
        userText.textContent = userMessage;
        
        messageContent.appendChild(userName);
        messageContent.appendChild(userText);
        userDiv.appendChild(avatar);
        userDiv.appendChild(messageContent);

        conversationItem.appendChild(userDiv);
        chatContainer.appendChild(conversationItem);
        chatContainer.scrollTop = chatContainer.scrollHeight;
      }

      // Listen for messages from extension
      window.addEventListener('message', event => {
        const message = event.data;
        
        switch (message.command) {
          case 'showTyping':
            showTypingIndicator();
            break;
          case 'addBotResponse':
            hideTypingIndicator();
            addDevCommandHubResponse(message.response);
            break;
          case 'updateJobStatus':
            updateJobStatusInChat(message.jobId, message.status, message.output, message.error_message);
            break;
        }
      });

      let typingIndicator = null;

      function showTypingIndicator() {
        if (typingIndicator) return;
        
        typingIndicator = document.createElement('div');
        typingIndicator.className = 'conversation-item';
        typingIndicator.innerHTML = \`
          <div class="bot-response">
            <div class="copilot-header">
              <div class="copilot-icon">⚡</div>
              <div class="copilot-label">DevCommandHub</div>
              <div class="copilot-meta">Processing...</div>
            </div>
            <div class="bot-message-content">
              <em>Processing your command...</em>
            </div>
          </div>
        \`;
        
        chatContainer.appendChild(typingIndicator);
        chatContainer.scrollTop = chatContainer.scrollHeight;
      }

      function hideTypingIndicator() {
        if (typingIndicator) {
          typingIndicator.remove();
          typingIndicator = null;
        }
      }

      function addDevCommandHubResponse(response) {
        const botDiv = document.createElement('div');
        botDiv.className = 'bot-response';
        
        const copilotHeader = document.createElement('div');
        copilotHeader.className = 'copilot-header';
        
        const copilotIcon = document.createElement('div');
        copilotIcon.className = 'copilot-icon';
        copilotIcon.textContent = '⚡';
        
        const copilotLabel = document.createElement('div');
        copilotLabel.className = 'copilot-label';
        copilotLabel.textContent = 'DevCommandHub';
        
        const copilotMeta = document.createElement('div');
        copilotMeta.className = 'copilot-meta';
        
        const botText = document.createElement('div');
        botText.className = 'bot-message-content';
        
        if (response.type === 'job_created') {
          copilotMeta.textContent = 'Job Created';
          
          const statusClass = response.status;
          const confidence = (response.parsed_intent.confidence * 100).toFixed(1);
          
          botText.innerHTML = \`
            <strong>✅ Command processed successfully!</strong><br><br>
            
            <strong>Job Details:</strong><br>
            📋 Job ID: <code>\${response.job_id}</code><br>
            🎯 Action: <strong>\${response.parsed_intent.action}</strong><br>
            \${response.parsed_intent.service ? \`🔧 Service: <strong>\${response.parsed_intent.service}</strong><br>\` : ''}
            \${response.parsed_intent.environment ? \`🌍 Environment: <strong>\${response.parsed_intent.environment}</strong><br>\` : ''}
            📊 Confidence: <strong>\${confidence}%</strong><br>
            📈 Status: <span class="status-badge \${statusClass}">\${response.status}</span><br>
            🕒 Created: \${new Date(response.created_at).toLocaleString()}<br><br>
            
            <button onclick="refreshJob('\${response.job_id}')" style="background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: none; padding: 6px 12px; border-radius: 3px; cursor: pointer;">
              🔄 Refresh Status
            </button>
          \`;
          
          botText.setAttribute('data-job-id', response.job_id);
        } else if (response.type === 'error') {
          copilotMeta.textContent = 'Error';
          botText.innerHTML = \`
            <strong>❌ Error processing command:</strong><br>
            \${response.message}
          \`;
        }
        
        copilotHeader.appendChild(copilotIcon);
        copilotHeader.appendChild(copilotLabel);
        copilotHeader.appendChild(copilotMeta);
        
        botDiv.appendChild(copilotHeader);
        botDiv.appendChild(botText);

        // Find the last conversation item and add this response to it
        const lastConversationItem = chatContainer.lastElementChild;
        if (lastConversationItem && lastConversationItem.className === 'conversation-item') {
          lastConversationItem.appendChild(botDiv);
        } else {
          // Create new conversation item if needed
          const conversationItem = document.createElement('div');
          conversationItem.className = 'conversation-item';
          conversationItem.appendChild(botDiv);
          chatContainer.appendChild(conversationItem);
        }
        
        chatContainer.scrollTop = chatContainer.scrollHeight;
      }

      // Global function for refresh button
      window.refreshJob = function(jobId) {
        vscode.postMessage({
          command: 'refreshJob',
          jobId: jobId
        });
      };

      function updateJobStatusInChat(jobId, status, output, errorMessage) {
        const jobElement = document.querySelector(\`[data-job-id="\${jobId}"]\`);
        if (jobElement) {
          // Update status in the existing job display
          const statusBadge = jobElement.querySelector('.status-badge');
          if (statusBadge) {
            statusBadge.textContent = status;
            statusBadge.className = \`status-badge \${status}\`;
          }
          
          // Add output or error if available
          if (output && output.length > 0) {
            const outputDiv = document.createElement('div');
            outputDiv.innerHTML = \`<br><strong>📄 Output:</strong><div class="code-block">\${output.join('\\n')}</div>\`;
            jobElement.appendChild(outputDiv);
          }
          
          if (errorMessage) {
            const errorDiv = document.createElement('div');
            errorDiv.innerHTML = \`<br><strong>❌ Error:</strong><div class="code-block">\${errorMessage}</div>\`;
            jobElement.appendChild(errorDiv);
          }
        }
      }

      // Add CSS for status badges
      const style = document.createElement('style');
      style.textContent = \`
        .status-badge {
          display: inline-block;
          padding: 2px 6px;
          border-radius: 3px;
          font-size: 0.8em;
          font-weight: bold;
          text-transform: uppercase;
        }
        .status-badge.queued { background-color: #ffd700; color: #000; }
        .status-badge.running { background-color: #007acc; color: #fff; }
        .status-badge.completed { background-color: #28a745; color: #fff; }
        .status-badge.failed { background-color: #dc3545; color: #fff; }
        .status-badge.cancelled { background-color: #6c757d; color: #fff; }
      \`;
      document.head.appendChild(style);
    </script>
    `;
  }

  dispose() {
    if (this.panel) {
      this.panel.dispose();
    }
  }
}

export function activate(context: vscode.ExtensionContext) {
  console.log('Congratulations, your extension "devcommandhub" is now active!');
  
  const provider = new DevCommandHubProvider(context);

  const disposable = vscode.commands.registerCommand('devcommandhub.openWindow', () => {
    provider.openWindow();
  });

  context.subscriptions.push(disposable);
  context.subscriptions.push(provider);
}

export function deactivate() {}