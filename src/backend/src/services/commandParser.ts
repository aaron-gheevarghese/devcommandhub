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

/** Normalize common environment aliases -> canonical names */
function normalizeEnvironment(env?: string): string | undefined {
  if (!env) {return env;}
  const e = env.trim().toLowerCase();
  const map: Record<string, string> = {
    prod: 'production',
    production: 'production',

    stage: 'staging',
    staging: 'staging',

    dev: 'development',
    develop: 'development',
    development: 'development',

    test: 'test',
    testing: 'test',
    qa: 'qa',
    uat: 'uat'
  };
  return map[e] || e;
}

/** Safe int parse with bounds */
function toInt(num: string, min = 0, max = 1000): number | undefined {
  const n = parseInt(num, 10);
  if (Number.isFinite(n) && n >= min && n <= max) {return n;}
  return undefined;
}

class CommandParser {
  private patterns: Array<{
    pattern: RegExp;
    action: ParsedIntent['action'];
    extract: (m: RegExpMatchArray) => ParsedIntent;
  }> = [
    // ---------------- DEPLOY ----------------
    // deploy <service> to <environment>
    {
      // allow "to" / "onto", optional "env"/"environment"
      pattern: /^deploy\s+([a-zA-Z0-9._-]+)\s+(?:to|onto)\s+([a-zA-Z0-9._-]+)(?:\s*(?:env|environment))?$/i,
      action: 'deploy',
      extract: (m) => ({
        action: 'deploy',
        service: m[1],
        environment: normalizeEnvironment(m[2]),
        confidence: 0.9
      })
    },
    // deploy <service>  (defaults to production)
    {
      pattern: /^deploy\s+([a-zA-Z0-9._-]+)$/i,
      action: 'deploy',
      extract: (m) => ({
        action: 'deploy',
        service: m[1],
        environment: 'production',
        confidence: 0.8
      })
    },

    // ---------------- LOGS ----------------
    // show logs for/of <service>
    {
      pattern: /^(?:show\s+)?logs?\s+(?:for|of)\s+([a-zA-Z0-9._-]+)(?:\s+last\s+(\d+)(?:\s*lines?)?)?$/i,
      action: 'logs',
      extract: (m) => ({
        action: 'logs',
        service: m[1],
        parameters: m[2] ? { tail: toInt(m[2], 1, 5000) } : undefined,
        confidence: 0.9
      })
    },
    // logs <service> [last N]
    {
      pattern: /^logs?\s+([a-zA-Z0-9._-]+)(?:\s+last\s+(\d+)(?:\s*lines?)?)?$/i,
      action: 'logs',
      extract: (m) => ({
        action: 'logs',
        service: m[1],
        parameters: m[2] ? { tail: toInt(m[2], 1, 5000) } : undefined,
        confidence: 0.85
      })
    },

    // ---------------- SCALE ----------------
    // scale <service> to <n> [replica|replicas]
    {
      pattern: /^scale\s+([a-zA-Z0-9._-]+)\s+to\s+(\d+)(?:\s*(?:replica|replicas))?$/i,
      action: 'scale',
      extract: (m) => ({
        action: 'scale',
        service: m[1],
        replicas: toInt(m[2], 0, 100),
        confidence: 0.95
      })
    },

    // ---------------- ROLLBACK ----------------
    {
      pattern: /^rollback\s+([a-zA-Z0-9._-]+)$/i,
      action: 'rollback',
      extract: (m) => ({
        action: 'rollback',
        service: m[1],
        confidence: 0.9
      })
    },

    // ---------------- STATUS ----------------
    // status/health [of] <service>
    {
      pattern: /^(?:status|health)\s+(?:of\s+)?([a-zA-Z0-9._-]+)$/i,
      action: 'status',
      extract: (m) => ({
        action: 'status',
        service: m[1],
        confidence: 0.85
      })
    },

    // ---------------- RESTART ----------------
    // restart <service> [in <env>]
    {
      pattern: /^restart\s+([a-zA-Z0-9._-]+)(?:\s+(?:in|on)\s+([a-zA-Z0-9._-]+))?$/i,
      action: 'restart',
      extract: (m) => ({
        action: 'restart',
        service: m[1],
        environment: normalizeEnvironment(m[2]),
        confidence: 0.9
      })
    }
  ];

  public parseCommand(command: string): ParseResult {
    const trimmed = (command || '').trim();

    if (!trimmed) {
      return { success: false, error: 'Command cannot be empty' };
    }

    for (const pat of this.patterns) {
      const match = trimmed.match(pat.pattern);
      if (match) {
        try {
          const intent = pat.extract(match);
          // Normalize any environment right away
          if (intent.environment) {intent.environment = normalizeEnvironment(intent.environment);}
          return { success: true, intent };
        } catch (e) {
          console.error('[Parser] extract error:', e);
          // continue to next pattern
        }
      }
    }

    // Helpful guidance
    return {
      success: false,
      error:
        `Could not parse command: "${command}". Try commands like:
- "deploy frontend to staging"
- "logs api-service last 100"
- "scale user-service to 3 replicas"
- "rollback auth-service"
- "status of payments"
- "restart backend in staging"`
    };
  }

  public getSupportedCommands(): string[] {
    return [
      'deploy <service> to <environment>',
      'deploy <service> (defaults to production)',
      'logs <service> [last <number>]',
      'show logs for <service> [last <number>]',
      'scale <service> to <number> [replicas]',
      'rollback <service>',
      'status of <service>',
      'restart <service> [in <environment>]'
    ];
  }

  public validateIntent(intent: ParsedIntent): { valid: boolean; error?: string } {
    if (!intent.action) {return { valid: false, error: 'Action is required' };}

    switch (intent.action) {
      case 'deploy': {
        if (!intent.service) {return { valid: false, error: 'Service name is required for deploy' };}
        const env = normalizeEnvironment(intent.environment);
        if (!env) {return { valid: false, error: 'Environment is required for deploy' };}
        intent.environment = env;
        break;
      }
      case 'scale': {
        if (!intent.service) {return { valid: false, error: 'Service name is required for scale' };}
        const r = intent.replicas;
        if (typeof r !== 'number' || r < 0 || r > 100) {
          return { valid: false, error: 'Replicas must be a number between 0 and 100' };
        }
        break;
      }
      case 'logs':
      case 'rollback':
      case 'status':
      case 'restart': {
        if (!intent.service) {return { valid: false, error: `Service name is required for ${intent.action}` };}
        if (intent.environment) {intent.environment = normalizeEnvironment(intent.environment);}
        break;
      }
      default:
        return { valid: false, error: `Unsupported action: ${intent.action}` };
    }

    return { valid: true };
  }
}

export const commandParser = new CommandParser();
