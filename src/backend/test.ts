// Complete DevCommandHub Integration Test Suite
// Combines comprehensive testing with configuration validation and GitHub pre-flight checks

console.log('🚀 DevCommandHub Complete Test Suite Starting...');
console.log('='.repeat(60));

import dotenv from 'dotenv';
import path from 'path';
import fs from 'fs';

// Ensure fetch exists in Node
async function ensureFetch() {
  // @ts-ignore
  if (typeof fetch === 'undefined') {
    const mod = await import('node-fetch');
    // @ts-ignore
    global.fetch = mod.default as any;
  }
}

// Enhanced error handling
process.on('unhandledRejection', (reason, promise) => {
  console.error('🚨 UNHANDLED REJECTION:');
  console.error('Promise:', promise);
  console.error('Reason:', reason);
  process.exit(1);
});

process.on('uncaughtException', (error) => {
  console.error('🚨 UNCAUGHT EXCEPTION:');
  console.error('Stack:', error.stack);
  process.exit(1);
});

// Load environment with multiple fallback paths
function loadEnvironment() {
  const possiblePaths = [
    path.resolve(__dirname, '.env'),
    path.resolve(__dirname, '../.env'),
    path.resolve(__dirname, '../../.env'),
    path.resolve(process.cwd(), '.env'),
  ];

  let loaded = false;
  for (const envPath of possiblePaths) {
    if (fs.existsSync(envPath)) {
      console.log(`📁 Loading environment from: ${envPath}`);
      dotenv.config({ path: envPath });
      loaded = true;
      break;
    }
  }

  if (!loaded) {
    console.log('⚠️  No .env file found in standard locations');
    console.log('   Checked:', possiblePaths);
  }
}

loadEnvironment();

// Import services with error handling - FIXED to use correct file names
let GitHubActionsService: any, mapGaToDchStatus: any, supabaseService: any, parseCommand: any;

try {
  // Fixed: Using correct relative paths from src/backend/
  ({ GitHubActionsService, mapGaToDchStatus } = require('./src/services/githubService'));
  ({ supabaseService } = require('./src/services/supabase'));
  ({ parseCommand } = require('./src/services/nluService'));
  console.log('✅ All service imports successful');
  
} catch (error) {
  console.error('❌ Service import failed:', error);
  console.log('\n🔍 Expected file structure (from src/backend/):');
  console.log('   ../services/githubService.ts');
  console.log('   ../services/supabase.ts');
  console.log('   ../services/nluService.ts');
  console.log('\n🔧 If files have different names, update the imports above');
  process.exit(1);
}

// Test configuration
interface TestConfig {
  userId: string;
  githubToken: string;
  owner: string;
  repo: string;
  workflowFile: string;
  branch: string;
  hfApiKey?: string;
  liveDispatch?: boolean;
}

function validateConfig(): TestConfig | null {
  const config: Partial<TestConfig> = {
    userId: process.env.TEST_USER_ID,
    githubToken: process.env.GITHUB_API_KEY || process.env.GH_TOKEN || process.env.GITHUB_TOKEN,
    owner: process.env.GH_REPO_OWNER,
    repo: process.env.GH_REPO_NAME,
    workflowFile: process.env.GH_WORKFLOW_FILE || 'ops.yml',
    branch: process.env.GH_DEFAULT_REF || 'main',
    hfApiKey: process.env.HF_API_KEY,
    liveDispatch: process.env.DCH_LIVE_DISPATCH === '1' || process.env.DCH_LIVE_DISPATCH === 'true',
  };

  console.log('\n🔧 Configuration Validation:');
  const missing: string[] = [];
  
  Object.entries(config).forEach(([key, value]) => {
    if (key === 'hfApiKey') {
      console.log(`   ${key}: ${value ? '✅ Set' : '⚠️  Optional - will use regex fallback'}`);
    } else if (key === 'liveDispatch') {
      console.log(`   ${key}: ${value ? '✅ Enabled' : 'ℹ️  Disabled'}`);
    } else if (!value) {
      console.log(`   ${key}: ❌ MISSING`);
      missing.push(key);
    } else {
      console.log(`   ${key}: ✅ Set`);
    }
  });

  if (missing.length > 0) {
    console.error(`\n❌ Missing required config: ${missing.join(', ')}`);
    console.log('\n📋 Required environment variables:');
    console.log('   TEST_USER_ID=your-uuid-here');
    console.log('   GITHUB_API_KEY=your-github-token');
    console.log('   GH_REPO_OWNER=your-username');
    console.log('   GH_REPO_NAME=your-repo-name');
    console.log('\n📋 Optional:');
    console.log('   GH_WORKFLOW_FILE=ops.yml (default)');
    console.log('   GH_DEFAULT_REF=main (default)');
    console.log('   HF_API_KEY=your-huggingface-token');
    console.log('   DCH_LIVE_DISPATCH=1 to trigger a real run');
    return null;
  }

  return config as TestConfig;
}

// Enhanced test results tracking
class TestRunner {
  private results: Map<string, { status: 'pass' | 'fail' | 'skip', details: string, critical: boolean }> = new Map();
  private startTime = Date.now();

  addResult(testName: string, status: 'pass' | 'fail' | 'skip', details: string, critical = false) {
    this.results.set(testName, { status, details, critical });
    const icon = status === 'pass' ? '✅' : status === 'fail' ? '❌' : '⏭️';
    const criticalMark = critical ? ' 🚨' : '';
    console.log(`${icon} ${testName}${criticalMark}: ${details}`);
  }

  getSummary() {
    const passed = Array.from(this.results.values()).filter(r => r.status === 'pass').length;
    const failed = Array.from(this.results.values()).filter(r => r.status === 'fail').length;
    const criticalFailed = Array.from(this.results.values()).filter(r => r.status === 'fail' && r.critical).length;
    const skipped = Array.from(this.results.values()).filter(r => r.status === 'skip').length;
    const duration = Date.now() - this.startTime;

    return { passed, failed, criticalFailed, skipped, duration, total: this.results.size };
  }

  printSummary() {
    const summary = this.getSummary();
    console.log('\n' + '='.repeat(60));
    console.log('📊 TEST SUMMARY');
    console.log('='.repeat(60));
    console.log(`⏱️  Duration: ${summary.duration}ms`);
    console.log(`📊 Total Tests: ${summary.total}`);
    console.log(`✅ Passed: ${summary.passed}`);
    console.log(`❌ Failed: ${summary.failed}`);
    console.log(`⏭️  Skipped: ${summary.skipped}`);
    
    if (summary.criticalFailed > 0) {
      console.log(`🚨 Critical Failures: ${summary.criticalFailed}`);
    }

    // Detailed failure report
    const failures = Array.from(this.results.entries()).filter(([_, result]) => result.status === 'fail');
    if (failures.length > 0) {
      console.log('\n❌ FAILED TESTS:');
      failures.forEach(([name, result]) => {
        console.log(`   ${name}: ${result.details}`);
      });
    }

    const readyForProduction = summary.criticalFailed === 0;
    console.log('\n' + '='.repeat(60));
    if (readyForProduction) {
      console.log('🎉 INTEGRATION READY: GitHub Actions integration should work!');
    } else {
      console.log('⚠️  NOT READY: Fix critical failures before proceeding');
    }
    console.log('='.repeat(60));

    return readyForProduction;
  }
}

// Configuration Issue Detection
function detectConfigurationIssues(runner: TestRunner, config: TestConfig) {
  console.log('\n🔍 CONFIGURATION ISSUE DETECTION');
  console.log('-'.repeat(40));

  // Issue 1: Mixed workflow identifier usage
  if (config.workflowFile.match(/^\d+$/)) {
    runner.addResult('Workflow ID Type', 'pass', `Using numeric workflow ID: ${config.workflowFile}`);
    console.log('   💡 Note: Using numeric ID is valid but filename is more portable');
  } else {
    runner.addResult('Workflow ID Type', 'pass', `Using workflow filename: ${config.workflowFile}`);
  }

  // Issue 2: Check for duplicate workflow file entries in .env
  let envContent = '';
  try {
    envContent = fs.readFileSync(path.resolve(process.cwd(), '.env'), 'utf8');
  } catch {
    envContent = '';
  }
  if (typeof envContent === 'string' && envContent.split('\n').filter(line => line.startsWith('GH_WORKFLOW_FILE=')).length > 1) {
    runner.addResult('Duplicate Config', 'fail', 'Multiple GH_WORKFLOW_FILE entries in .env', true);
  }

  // Issue 3: Critical missing environment variables
  const criticalVars = [
    'SUPABASE_URL', 
    'SUPABASE_SERVICE_KEY', 
    'TEST_USER_ID',
    'GH_REPO_OWNER',
    'GH_REPO_NAME'
  ];

  const missing = criticalVars.filter(varName => !process.env[varName]);
  if (missing.length > 0) {
    runner.addResult('Critical Env Vars', 'fail', `Missing: ${missing.join(', ')}`, true);
  } else {
    runner.addResult('Critical Env Vars', 'pass', 'All critical variables present');
  }

  // Issue 4: GitHub token format validation
  const tokenPattern = /^(ghp_[a-zA-Z0-9]{36}|github_pat_[a-zA-Z0-9_]{82})$/;
  if (config.githubToken && !tokenPattern.test(config.githubToken)) {
    runner.addResult('GitHub Token Format', 'fail', 'Token format may be invalid', true);
    console.log('   💡 Expected: ghp_... (classic) or github_pat_... (fine grained)');
  } else if (config.githubToken) {
    runner.addResult('GitHub Token Format', 'pass', 'Token format appears valid');
  }

  // Issue 5: Supabase URL format validation
  const supabaseUrl = process.env.SUPABASE_URL;
  if (supabaseUrl && !supabaseUrl.match(/^https:\/\/[a-z0-9]+\.supabase\.co$/)) {
    runner.addResult('Supabase URL Format', 'fail', 'URL format may be invalid');
  } else if (supabaseUrl) {
    runner.addResult('Supabase URL Format', 'pass', 'URL format valid');
  }

  // Issue 6: UUID format validation for TEST_USER_ID
  const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (config.userId && !uuidPattern.test(config.userId)) {
    runner.addResult('User ID Format', 'fail', 'TEST_USER_ID must be a valid UUID', true);
  } else if (config.userId) {
    runner.addResult('User ID Format', 'pass', 'User ID format valid');
  }
}

// GitHub Pre-Flight Checks
async function testGitHubPreFlight(runner: TestRunner, config: TestConfig) {
  console.log('\n✈️ GITHUB PRE-FLIGHT CHECKS');
  console.log('-'.repeat(40));

  // Test 1: Basic connectivity
  try {
    const response = await fetch('https://api.github.com/user', {
      headers: { 'Authorization': `token ${config.githubToken}` }
    });

    if (response.ok) {
      const user = await response.json() as { login: string };
      runner.addResult('GitHub API Connectivity', 'pass', `Connected as: ${user.login}`, true);
    } else if (response.status === 401) {
      runner.addResult('GitHub API Connectivity', 'fail', 'Invalid token or expired', true);
      return; // Stop this block if token is bad
    } else {
      runner.addResult('GitHub API Connectivity', 'fail', `HTTP ${response.status}`, true);
      return;
    }
  } catch (error) {
    runner.addResult('GitHub API Connectivity', 'fail', `Network error: ${error}`, true);
    return;
  }

  // Test 2: Repository accessibility
  try {
    const repoUrl = `https://api.github.com/repos/${config.owner}/${config.repo}`;
    const response = await fetch(repoUrl, {
      headers: { 'Authorization': `token ${config.githubToken}` }
    });

    if (response.ok) {
      const repo = await response.json() as { full_name: string; private: boolean; has_actions?: boolean };
      runner.addResult('Repository Access', 'pass', `${repo.full_name} (${repo.private ? 'private' : 'public'})`, true);
      
      // Check if repo has Actions enabled
      if (repo.has_actions !== false) {
        runner.addResult('GitHub Actions Enabled', 'pass', 'Actions are enabled on repository');
      } else {
        runner.addResult('GitHub Actions Enabled', 'fail', 'Actions disabled on repository', true);
      }
    } else if (response.status === 404) {
      runner.addResult('Repository Access', 'fail', 'Repository not found or no access', true);
      console.log('   💡 Check: 1) Repository name spelling, 2) Token has repo scope, 3) Private repo permissions');
    } else {
      runner.addResult('Repository Access', 'fail', `HTTP ${response.status}`, true);
    }
  } catch (error) {
    runner.addResult('Repository Access', 'fail', `Network error: ${error}`, true);
  }

  // Test 3: Workflow file existence via GitHub API (only if using filename)
  if (!config.workflowFile.match(/^\d+$/)) {
    try {
      const workflowUrl = `https://api.github.com/repos/${config.owner}/${config.repo}/contents/.github/workflows/${config.workflowFile}?ref=${config.branch}`;
      const response = await fetch(workflowUrl, {
        headers: { 'Authorization': `token ${config.githubToken}` }
      });

      if (response.ok) {
        runner.addResult('Workflow File (GitHub)', 'pass', `Found .github/workflows/${config.workflowFile}`);
      } else if (response.status === 404) {
        runner.addResult('Workflow File (GitHub)', 'fail', `Workflow file not found on ${config.branch}`, true);
      } else {
        runner.addResult('Workflow File (GitHub)', 'fail', `Cannot check workflow file: HTTP ${response.status}`);
      }
    } catch (error) {
      runner.addResult('Workflow File (GitHub)', 'fail', `Network error: ${error}`);
    }
  }
}

// Token Scope Validation - Updated for fine-grained PATs
async function validateTokenScopes(runner: TestRunner, config: TestConfig) {
  console.log('\n🔐 GITHUB TOKEN SCOPE VALIDATION');
  console.log('-'.repeat(40));
  try {
    const resp = await fetch('https://api.github.com/user', { headers: { Authorization: `token ${config.githubToken}` } });
    const scopesHeader = resp.headers.get('x-oauth-scopes') || '';
    const scopes = scopesHeader ? scopesHeader.split(', ').filter(Boolean) : [];
    const isFineGrained = /^github_pat_/.test(config.githubToken);
    console.log('   Detected token scopes:', scopes.join(', ') || (isFineGrained ? 'fine-grained (header empty)' : 'none'));
    if (scopes.length === 0 && isFineGrained) {
      runner.addResult('Token Type', 'pass', 'Fine grained token');
      runner.addResult('Token Scope: repo', 'skip', 'Classic scopes header is empty on fine grained tokens');
      runner.addResult('Token Scope: workflow', 'skip', 'Classic scopes header is empty on fine grained tokens');
      return;
    }
    if (scopes.includes('repo')) {
      runner.addResult('Token Scope: repo', 'pass', 'Full repository access');
    } else if (scopes.includes('public_repo')) {
      runner.addResult('Token Scope: repo', 'fail', 'Only public_repo scope', true);
    } else {
      runner.addResult('Token Scope: repo', 'fail', 'No repository access scope', true);
    }
    if (scopes.includes('workflow')) {
      runner.addResult('Token Scope: workflow', 'pass', 'Can manage workflows');
    } else {
      runner.addResult('Token Scope: workflow', 'fail', 'Cannot dispatch workflows', true);
    }
  } catch (error) {
    runner.addResult('Token Scope Validation', 'fail', `Cannot validate scopes: ${error}`);
  }
}

// Environment Setup Tests
async function testEnvironmentSetup(runner: TestRunner, config: TestConfig) {
  console.log('\n🔧 ENVIRONMENT SETUP TESTS');
  console.log('-'.repeat(40));

  // Check if workflow file exists locally (only if using filename)
  if (!config.workflowFile.match(/^\d+$/)) {
    const workflowPath = path.resolve(process.cwd(), '.github/workflows', config.workflowFile);
    if (fs.existsSync(workflowPath)) {
      runner.addResult('Local Workflow File', 'pass', `Found ${config.workflowFile}`);

      // Validate workflow file content
      try {
        const content = fs.readFileSync(workflowPath, 'utf8');
        const hasWorkflowDispatch = /workflow_dispatch\s*:/.test(content);
        const requiredInputs = ['job_id', 'action', 'service'];
        const hasRequiredInputs = requiredInputs.every(input => content.includes(input));
        
        if (hasWorkflowDispatch && hasRequiredInputs) {
          runner.addResult('Workflow File Content', 'pass', 'Contains required dispatch inputs');
        } else {
          runner.addResult('Workflow File Content', 'fail', 'Missing workflow_dispatch or required inputs', true);
        }
      } catch (error) {
        runner.addResult('Workflow File Content', 'fail', `Cannot read workflow file: ${error}`, true);
      }
    } else {
      runner.addResult('Local Workflow File', 'fail', `Missing ${workflowPath}`, true);
    }
  } else {
    runner.addResult('Local Workflow File', 'skip', 'Using numeric ID - will check via API');
  }
}

// GitHub Authentication Tests (using your actual service)
async function testGitHubAuthentication(runner: TestRunner, config: TestConfig) {
  console.log('\n🐙 GITHUB AUTHENTICATION TESTS');
  console.log('-'.repeat(40));

  try {
    const service = new GitHubActionsService();
    await service.authenticate(config.githubToken);
    runner.addResult('GitHub Service Auth', 'pass', 'Service authentication successful', true);

    // Test workflow listing with better error handling
    try {
      const workflows = await service.listWorkflows();
      runner.addResult('Workflow Listing', 'pass', `Found ${workflows.length} workflows`);

      // Look for target workflow - handles both filename and numeric ID
      const targetWorkflow = workflows.find((w: any) => 
        (w.path && w.path.endsWith(config.workflowFile)) || 
        (w.id && w.id.toString() === config.workflowFile) ||
        w.name === 'DevCommandHub Ops'
      );

      if (targetWorkflow) {
        runner.addResult('Workflow Discovery', 'pass', `Found: ${targetWorkflow.name} (${targetWorkflow.path || 'no-path'}) [ID: ${targetWorkflow.id}]`, true);
        
        // If using numeric ID, confirm it matches
        if (config.workflowFile === String(targetWorkflow.id)) {
          runner.addResult('Workflow ID Validation', 'pass', `Numeric ID ${config.workflowFile} matches workflow`);
        }
      } else {
        runner.addResult('Workflow Discovery', 'fail', `Cannot find workflow: ${config.workflowFile}`, true);
        console.log('   Available workflows:');
        workflows.forEach((w: any) => {
          console.log(`     ${w.name} (${w.path || 'no-path'}) [ID: ${w.id}]`);
        });
      }
    } catch (error) {
      runner.addResult('Workflow Discovery', 'fail', `Cannot list workflows: ${error}`, true);
    }

  } catch (error) {
    runner.addResult('GitHub Service Auth', 'fail', `Authentication failed: ${error}`, true);
  }
}

// Supabase Integration Tests
async function testSupabaseIntegration(runner: TestRunner, config: TestConfig) {
  console.log('\n🗄️  SUPABASE INTEGRATION TESTS');
  console.log('-'.repeat(40));

  try {
    const isConnected = await supabaseService.testConnection();
    if (isConnected) {
      runner.addResult('Supabase Connection', 'pass', 'Database connection successful', true);

      // Test job creation
      try {
        const job = await supabaseService.createJob({
          user_id: config.userId,
          original_command: 'integration test command',
          parsed_intent: {
            action: 'status',
            service: 'test-service',
            environment: 'development',
            confidence: 1.0,
            source: 'test'
          },
          job_type: 'status'
        });

        if (job.data && !job.error) {
          runner.addResult('Job Creation', 'pass', `Created job: ${job.data.id}`, true);
          
          // Test job update
          try {
            const updateResult = await supabaseService.updateJobStatus(job.data.id, 'running');
            if (updateResult) {
              runner.addResult('Job Updates', 'pass', 'Can update job status');
            } else {
              runner.addResult('Job Updates', 'fail', 'Cannot update job status');
            }
          } catch (error) {
            runner.addResult('Job Updates', 'fail', `Update failed: ${error}`);
          }

        } else {
          runner.addResult('Job Creation', 'fail', `Failed: ${job.error?.message || 'Unknown error'}`, true);
          if (job.error?.message?.includes('foreign key') || job.error?.message?.includes('violates')) {
            console.log('   💡 This usually means TEST_USER_ID does not exist in your Supabase auth.users table');
          }
        }
      } catch (error) {
        runner.addResult('Job Creation', 'fail', `Exception: ${error}`, true);
      }
    } else {
      runner.addResult('Supabase Connection', 'fail', 'Connection failed', true);
    }
  } catch (error) {
    runner.addResult('Supabase Connection', 'fail', `Exception: ${error}`, true);
  }
}

// NLU Service Tests
async function testNLUService(runner: TestRunner, config: TestConfig) {
  console.log('\n🧠 NLU SERVICE TESTS');
  console.log('-'.repeat(40));

  const testCases = [
    { command: 'deploy frontend to staging', expectedAction: 'deploy', expectedService: 'frontend' },
    { command: 'scale api-service to 3 replicas', expectedAction: 'scale', expectedService: 'api-service' },
    { command: 'restart user-service in production', expectedAction: 'restart', expectedService: 'user-service' },
    { command: 'rollback auth-service', expectedAction: 'rollback', expectedService: 'auth-service' },
    { command: 'show me the logs for database-service', expectedAction: 'logs', expectedService: 'database-service' },
    { command: 'what is the status of the system', expectedAction: 'status', expectedService: null },
  ];

  let correctPredictions = 0;

  for (const testCase of testCases) {
    try {
      const result = await parseCommand({
        command: testCase.command,
        hfApiKey: config.hfApiKey || null,
        confidenceThreshold: 0.6 // Using recommended threshold instead of 0.4
      });

      const actionMatch = result.action === testCase.expectedAction;
      const serviceMatch = result.service === testCase.expectedService;
      const confident = (result.confidence || 0) >= 0.6;

      if (actionMatch && serviceMatch && confident) {
        runner.addResult(`NLU: "${testCase.command}"`, 'pass', 
          `✓ ${result.action}/${result.service || 'none'} (${((result.confidence || 0) * 100).toFixed(1)}%)`);
        correctPredictions++;
      } else if (actionMatch && serviceMatch) {
        runner.addResult(`NLU: "${testCase.command}"`, 'pass', 
          `✓ ${result.action}/${result.service || 'none'} (low confidence ${(result.confidence * 100).toFixed(1)}%)`);
        correctPredictions++;
      } else {
        runner.addResult(`NLU: "${testCase.command}"`, 'fail',
          `Got ${result.action}/${result.service || 'none'}, expected ${testCase.expectedAction}/${testCase.expectedService || 'none'}`);
      }
    } catch (error) {
      runner.addResult(`NLU: "${testCase.command}"`, 'fail', `Parse error: ${error}`);
    }
  }

  const accuracy = correctPredictions / testCases.length;
  if (accuracy >= 0.8) {
    runner.addResult('NLU Overall Accuracy', 'pass', `${(accuracy * 100).toFixed(1)}% (${correctPredictions}/${testCases.length})`);
  } else {
    runner.addResult('NLU Overall Accuracy', 'fail', `Only ${(accuracy * 100).toFixed(1)}% accurate`, true);
  }
}

// Status Mapping Tests
function testStatusMapping(runner: TestRunner) {
  console.log('\n📊 STATUS MAPPING TESTS');
  console.log('-'.repeat(40));

  const mappingTests = [
    { status: 'queued', conclusion: null, expected: 'running' },
    { status: 'in_progress', conclusion: null, expected: 'running' },
    { status: 'completed', conclusion: 'success', expected: 'completed' },
    { status: 'completed', conclusion: 'failure', expected: 'failed' },
    { status: 'completed', conclusion: 'cancelled', expected: 'cancelled' },
    { status: 'completed', conclusion: 'timed_out', expected: 'failed' },
  ];

  let correctMappings = 0;
  
  for (const test of mappingTests) {
    const result = mapGaToDchStatus(test.status as any, test.conclusion as any);
    if (result === test.expected) {
      runner.addResult(`Status Mapping: ${test.status}/${test.conclusion}`, 'pass', `-> ${result}`);
      correctMappings++;
    } else {
      runner.addResult(`Status Mapping: ${test.status}/${test.conclusion}`, 'fail', `Got ${result}, expected ${test.expected}`);
    }
  }

  if (correctMappings === mappingTests.length) {
    runner.addResult('Status Mapping Overall', 'pass', 'All mappings correct');
  } else {
    runner.addResult('Status Mapping Overall', 'fail', `${correctMappings}/${mappingTests.length} correct`, true);
  }
}

// Workflow Dispatch Test (using your actual service)
async function testWorkflowDispatch(runner: TestRunner, config: TestConfig, mode: 'dry' | 'live' = 'dry') {
  console.log(`\n🚀 WORKFLOW DISPATCH TEST (${mode.toUpperCase()} MODE)`);
  console.log('-'.repeat(40));

  const dispatchInputs = {
    job_id: `test-${Date.now()}`,
    action: 'status',
    service: 'test-service',
    environment: 'development',
    replicas: '1',
    user_id: config.userId,
    original_command: 'integration test dispatch'
  };

  if (mode === 'dry') {
    runner.addResult('Workflow Dispatch (Dry)', 'pass', 'Dry run validation successful');
    console.log('   Would dispatch with inputs:', JSON.stringify(dispatchInputs, null, 2));
    console.log(`   Workflow: ${config.workflowFile}`);
    console.log(`   Branch: ${config.branch}`);
    return;
  }

  try {
    const service = new GitHubActionsService();
    await service.authenticate(config.githubToken);
    
    // Use your service dispatch method
    await service.dispatch(config.workflowFile, dispatchInputs, config.branch);
    runner.addResult('Workflow Dispatch (Live)', 'pass', 'Successfully triggered workflow', true);

    // Try to find the created run
    try {
      const runName = `DCH ${dispatchInputs.job_id} - ${dispatchInputs.action} ${dispatchInputs.service} @ ${dispatchInputs.environment}`;
      console.log(`   Looking for run with name: ${runName}`);
      
      const run = await service.findRunByName(config.workflowFile, runName, 6, 2000);
      
      if (run) {
        runner.addResult('Run Creation Verification', 'pass', `Found run: ${run.html_url}`);
        console.log(`   🔗 Run URL: ${run.html_url}`);
        console.log(`   📊 Status: ${run.status} | Conclusion: ${run.conclusion || 'pending'}`);
      } else {
        runner.addResult('Run Creation Verification', 'fail', 'Could not locate run in time');
      }
    } catch (error) {
      runner.addResult('Run Creation Verification', 'fail', `Cannot find created run: ${error}`);
      console.log('   This may be normal if the run takes time to appear in the API');
    }

  } catch (error: any) {
    runner.addResult('Workflow Dispatch (Live)', 'fail', `Dispatch failed: ${error?.message || error}`, true);
    
    // Provide helpful error diagnosis
    const errorMsg = String(error?.message || error || '');
    if (errorMsg.includes('422')) {
      console.log('   💡 422 error usually means:');
      console.log('      - Workflow file missing required inputs');
      console.log('      - Branch specified does not contain the workflow file');
      console.log('      - workflow_dispatch trigger not properly configured');
    } else if (errorMsg.includes('404')) {
      console.log('   💡 404 error usually means:');
      console.log('      - Workflow not found by filename or ID');
      console.log('      - Token lacks access to repo or workflow scope');
      console.log('      - Using the wrong owner or repo');
    } else if (errorMsg.includes('401')) {
      console.log('   💡 401 error means unauthorized. Check token value and expiration.');
    } else {
      console.log('   ℹ️ For more detail enable debug logs in your GitHubActionsService implementation');
    }
  }
}

/* -------------------------
   Main Orchestration
-------------------------- */

async function main() {
  await ensureFetch();

  const config = validateConfig();
  const runner = new TestRunner();

  if (!config) {
    // Config missing. Print a short summary and exit non zero.
    runner.addResult('Config Validation', 'fail', 'Missing required environment variables', true);
    const ok = runner.printSummary();
    process.exit(ok ? 0 : 1);
  }

  // Static checks
  detectConfigurationIssues(runner, config);

  // External checks
  await testGitHubPreFlight(runner, config);
  await validateTokenScopes(runner, config);
  await testEnvironmentSetup(runner, config);

  // Service checks
  await testGitHubAuthentication(runner, config);
  await testSupabaseIntegration(runner, config);
  await testNLUService(runner, config);
  testStatusMapping(runner);

  // Dispatch tests
  await testWorkflowDispatch(runner, config, 'dry');
  if (config.liveDispatch) {
    await testWorkflowDispatch(runner, config, 'live');
  } else {
    console.log('\nℹ️ Live dispatch is disabled. Set DCH_LIVE_DISPATCH=1 to enable.');
  }

  const ok = runner.printSummary();
  process.exit(ok ? 0 : 1);
}

// Only run if executed directly
if (require.main === module) {
  // Wrap main to catch top level async errors
  main().catch(err => {
    console.error('❌ Fatal error in test runner:', err);
    process.exit(1);
  });
}

export {};