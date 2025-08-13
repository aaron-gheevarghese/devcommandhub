// src/backend/src/services/commandParser.ts

export interface ParsedIntent {
  action: string;
  service?: string;
  environment?: string;
  replicas?: number;
  parameters?: Record<string, any>;
  confidence: number;
}

export interface ParseResult {
  success: boolean;
  intent?: ParsedIntent;
  error?: string;
}

class CommandParser {
  private patterns = [
    // Deploy patterns
    {
      pattern: /^deploy\s+([a-zA-Z0-9-_]+)\s+to\s+([a-zA-Z0-9-_]+)$/i,
      action: 'deploy',
      extract: (match: RegExpMatchArray): ParsedIntent => ({
        action: 'deploy',
        service: match[1],
        environment: match[2],
        confidence: 0.9
      })
    },
    {
      pattern: /^deploy\s+([a-zA-Z0-9-_]+)$/i,
      action: 'deploy',
      extract: (match: RegExpMatchArray): ParsedIntent => ({
        action: 'deploy',
        service: match[1],
        environment: 'production', // default
        confidence: 0.8
      })
    },

    // Logs patterns
    {
      pattern: /^(show\s+)?(logs?\s+for|logs?)\s+([a-zA-Z0-9-_]+)$/i,
      action: 'logs',
      extract: (match: RegExpMatchArray): ParsedIntent => ({
        action: 'logs',
        service: match[3],
        confidence: 0.9
      })
    },
    {
      pattern: /^logs?\s+([a-zA-Z0-9-_]+)$/i,
      action: 'logs',
      extract: (match: RegExpMatchArray): ParsedIntent => ({
        action: 'logs',
        service: match[1],
        confidence: 0.85
      })
    },

    // Scale patterns
    {
      pattern: /^scale\s+([a-zA-Z0-9-_]+)\s+to\s+(\d+)$/i,
      action: 'scale',
      extract: (match: RegExpMatchArray): ParsedIntent => ({
        action: 'scale',
        service: match[1],
        replicas: parseInt(match[2], 10),
        confidence: 0.95
      })
    },

    // Rollback patterns
    {
      pattern: /^rollback\s+([a-zA-Z0-9-_]+)$/i,
      action: 'rollback',
      extract: (match: RegExpMatchArray): ParsedIntent => ({
        action: 'rollback',
        service: match[1],
        confidence: 0.9
      })
    },

    // Status patterns
    {
      pattern: /^(status|health)\s+(of\s+)?([a-zA-Z0-9-_]+)$/i,
      action: 'status',
      extract: (match: RegExpMatchArray): ParsedIntent => ({
        action: 'status',
        service: match[3],
        confidence: 0.85
      })
    },

    // Restart patterns
    {
      pattern: /^restart\s+([a-zA-Z0-9-_]+)$/i,
      action: 'restart',
      extract: (match: RegExpMatchArray): ParsedIntent => ({
        action: 'restart',
        service: match[1],
        confidence: 0.9
      })
    }
  ];

  public parseCommand(command: string): ParseResult {
    const trimmedCommand = command.trim();
    
    if (!trimmedCommand) {
      return {
        success: false,
        error: 'Command cannot be empty'
      };
    }

    // Try each pattern
    for (const pattern of this.patterns) {
      const match = trimmedCommand.match(pattern.pattern);
      if (match) {
        try {
          const intent = pattern.extract(match);
          return {
            success: true,
            intent
          };
        } catch (error) {
          console.error('Error extracting intent:', error);
          continue;
        }
      }
    }

    // No pattern matched
    return {
      success: false,
      error: `Could not parse command: "${command}". Try commands like:
- "deploy frontend to staging"
- "show logs for api-service"
- "scale user-service to 3"
- "rollback auth-service"`
    };
  }

  public getSupportedCommands(): string[] {
    return [
      'deploy <service> to <environment>',
      'deploy <service> (defaults to production)',
      'show logs for <service>',
      'logs <service>',
      'scale <service> to <number>',
      'rollback <service>',
      'status of <service>',
      'restart <service>'
    ];
  }

  public validateIntent(intent: ParsedIntent): { valid: boolean; error?: string } {
    // Basic validation
    if (!intent.action) {
      return { valid: false, error: 'Action is required' };
    }

    // Action-specific validation
    switch (intent.action) {
      case 'deploy':
        if (!intent.service) {
          return { valid: false, error: 'Service name is required for deploy' };
        }
        if (!intent.environment) {
          return { valid: false, error: 'Environment is required for deploy' };
        }
        break;

      case 'scale':
        if (!intent.service) {
          return { valid: false, error: 'Service name is required for scale' };
        }
        if (!intent.replicas || intent.replicas < 0 || intent.replicas > 100) {
          return { valid: false, error: 'Replicas must be between 0 and 100' };
        }
        break;

      case 'logs':
      case 'rollback':
      case 'status':
      case 'restart':
        if (!intent.service) {
          return { valid: false, error: `Service name is required for ${intent.action}` };
        }
        break;

      default:
        return { valid: false, error: `Unsupported action: ${intent.action}` };
    }

    return { valid: true };
  }
}

export const commandParser = new CommandParser();