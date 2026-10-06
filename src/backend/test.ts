// Enhanced DevCommandHub Integration Test Suite
// Adapted to match your actual production service structure

console.log('🚀 DevCommandHub Enhanced Integration Test Suite');
console.log('Focus: Cross-repository compatibility and real-world usage');
console.log('='.repeat(70));

import dotenv from 'dotenv';
import path from 'path';
import fs from 'fs';
import * as yaml from 'js-yaml';

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

// Import services with error handling - matching YOUR actual structure
let GitHubActionsService: any, mapGaToDchStatus: any, supabaseService: any, parseCommand: any;

try {
  ({ GitHubActionsService, mapGaToDchStatus } = require('./src/services/githubService'));
  ({ supabaseService } = require('./src/services/supabase'));
  ({ parseCommand } = require('./src/services/nluService'));
  console.log('✅ All service imports successful');
} catch (error) {
  console.error('❌ Service import failed:', error);
  console.log('\n🔍 Expected file structure (from src/backend/):');
  console.log('   ./src/services/githubService.ts');
  console.log('   ./src/services/supabase.ts');
  console.log('   ./src/services/nluService.ts');
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
      console.log(`   ${key}: ${value ? '✅ Enabled' : 'ℹ️  Disabled (dry-run mode)'}`);
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
    console.log('   DCH_LIVE_DISPATCH=1 to enable real GitHub Actions runs');
    return null;
  }

  return config as TestConfig;
}

// Enhanced test results tracking
class TestRunner {
  private results: Map<string, { status: 'pass' | 'fail' | 'skip', details: string, critical: boolean, category: string }> = new Map();
  private startTime = Date.now();

  public getResult(testName: string) {
    return this.results.get(testName);
  }

  addResult(testName: string, status: 'pass' | 'fail' | 'skip', details: string, critical = false, category = 'general') {
    this.results.set(testName, { status, details, critical, category });
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

  getCategoryResults(category: string) {
    const categoryResults = Array.from(this.results.entries()).filter(([_, result]) => result.category === category);
    const passed = categoryResults.filter(([_, result]) => result.status === 'pass').length;
    const failed = categoryResults.filter(([_, result]) => result.status === 'fail').length;
    const total = categoryResults.length;
    return { passed, failed, total, success: failed === 0 };
  }

  printSummary() {
    const summary = this.getSummary();
    console.log('\n' + '='.repeat(70));
    console.log('📊 TEST SUMMARY - PRODUCTION READINESS ASSESSMENT');
    console.log('='.repeat(70));
    console.log(`⏱️  Duration: ${summary.duration}ms`);
    console.log(`📊 Total Tests: ${summary.total}`);
    console.log(`✅ Passed: ${summary.passed}`);
    console.log(`❌ Failed: ${summary.failed}`);
    console.log(`⏭️  Skipped: ${summary.skipped}`);
    
    if (summary.criticalFailed > 0) {
      console.log(`🚨 Critical Failures: ${summary.criticalFailed}`);
    }

    // Category breakdown
    console.log('\n📋 Results by Category:');
    const categories = ['portability', 'workflow-validation', 'nlu-robustness', 'integration', 'user-experience'];
    categories.forEach(category => {
      const catResults = this.getCategoryResults(category);
      if (catResults.total > 0) {
        const status = catResults.success ? '✅' : '❌';
        console.log(`   ${status} ${category}: ${catResults.passed}/${catResults.total}`);
      }
    });

    // Detailed failure report
    const failures = Array.from(this.results.entries()).filter(([_, result]) => result.status === 'fail');
    if (failures.length > 0) {
      console.log('\n❌ FAILED TESTS:');
      failures.forEach(([name, result]) => {
        const criticalMark = result.critical ? ' 🚨 CRITICAL' : '';
        console.log(`   ${name}${criticalMark}: ${result.details}`);
      });
    }

    // Production readiness assessment
    const portabilityResults = this.getCategoryResults('portability');
    const workflowResults = this.getCategoryResults('workflow-validation');
    const integrationResults = this.getCategoryResults('integration');
    
    const isPortable = portabilityResults.success;
    const workflowsReady = workflowResults.success;
    const integrationReady = integrationResults.success;
    const noCriticalFailures = summary.criticalFailed === 0;
    
    const readyForOtherUsers = isPortable && workflowsReady && integrationReady && noCriticalFailures;

    console.log('\n' + '='.repeat(70));
    console.log('🎯 PRODUCTION READINESS FOR OTHER DEVELOPERS:');
    console.log('='.repeat(70));
    console.log(`📦 Cross-repo Portability: ${isPortable ? '✅ Ready' : '❌ Not Ready'}`);
    console.log(`⚙️  Workflow Integration: ${workflowsReady ? '✅ Ready' : '❌ Not Ready'}`);
    console.log(`🔗 Service Integration: ${integrationReady ? '✅ Ready' : '❌ Not Ready'}`);
    console.log(`🚨 Critical Issues: ${noCriticalFailures ? '✅ None' : '❌ Present'}`);
    
    console.log('\n' + '='.repeat(70));
    if (readyForOtherUsers) {
      console.log('🎉 READY FOR OTHER DEVELOPERS!');
      console.log('   Other devs can use DevCommandHub with their repos');
      console.log('   assuming they have proper ops.yml workflow files.');
    } else {
      console.log('⚠️  NOT READY FOR OTHER DEVELOPERS');
      console.log('   Fix the issues above before releasing to other users.');
    }
    console.log('='.repeat(70));

    return readyForOtherUsers;
  }
}

// Environment Setup Tests
async function testEnvironmentSetup(runner: TestRunner, config: TestConfig) {
  console.log('\n🔧 ENVIRONMENT SETUP VALIDATION');
  console.log('-'.repeat(40));

  const criticalVars = [
    'SUPABASE_URL', 'SUPABASE_SERVICE_KEY', 'TEST_USER_ID',
    'GITHUB_API_KEY', 'GH_REPO_OWNER', 'GH_REPO_NAME'
  ];

  const missing = criticalVars.filter(varName => !process.env[varName]);
  if (missing.length === 0) {
    runner.addResult('Critical Environment Variables', 'pass', 'All required variables present', true, 'integration');
  } else {
    runner.addResult('Critical Environment Variables', 'fail', `Missing: ${missing.join(', ')}`, true, 'integration');
  }

  const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (config.userId && uuidPattern.test(config.userId)) {
    runner.addResult('User ID Format', 'pass', 'Valid UUID format', false, 'integration');
  } else {
    runner.addResult('User ID Format', 'fail', 'TEST_USER_ID must be a valid UUID', true, 'integration');
  }
}

// GitHub Authentication Tests
async function testGitHubAuth(runner: TestRunner, config: TestConfig) {
  console.log('\n🐙 GITHUB AUTHENTICATION & ACCESS');
  console.log('-'.repeat(40));

  const github = new GitHubActionsService(config.githubToken, config.owner, config.repo, config.workflowFile, config.branch);

  try {
    await github.authenticate();
    runner.addResult('GitHub Authentication', 'pass', 'Authentication successful', true, 'integration');
  } catch (e: any) {
    runner.addResult('GitHub Authentication', 'fail', e.message, true, 'integration');
    return;
  }

  try {
    const workflowDetails = await github.getWorkflowDetails();
    runner.addResult('Workflow Access', 'pass', `Found: ${workflowDetails.name} [ID: ${workflowDetails.id}]`, true, 'integration');
  } catch (e: any) {
    runner.addResult('Workflow Access', 'fail', e.message, true, 'integration');
  }
}

// Supabase Integration Tests - ADAPTED TO YOUR ACTUAL SERVICE
async function testSupabaseIntegration(runner: TestRunner, config: TestConfig) {
  console.log('\n🗄️  SUPABASE DATABASE INTEGRATION');
  console.log('-'.repeat(40));

  try {
    const isConnected = await supabaseService.testConnection();
    if (isConnected) {
      runner.addResult('Database Connection', 'pass', 'Supabase connection successful', true, 'integration');
    } else {
      runner.addResult('Database Connection', 'fail', 'Cannot connect to Supabase', true, 'integration');
      return;
    }
  } catch (e: any) {
    runner.addResult('Database Connection', 'fail', e.message, true, 'integration');
    return;
  }

  try {
    // Use YOUR actual createJob interface
    const result = await supabaseService.createJob({
      user_id: config.userId,
      original_command: 'integration test',
      parsed_intent: {
        action: 'test',
        service: 'test-service',
        environment: 'development'
      },
      job_type: 'test'
    });

    if (result.error || !result.data) {
      runner.addResult('Job Creation', 'fail', `Error: ${result.error?.message || 'No data returned'}`, true, 'integration');
      return;
    }

    const jobId = result.data.id;
    runner.addResult('Job Creation', 'pass', `Created job: ${jobId}`, true, 'integration');

    // Test job updates using YOUR actual interface
    const updateSuccess = await supabaseService.updateJobStatus(jobId, 'running', {});
    if (updateSuccess) {
      const completeSuccess = await supabaseService.updateJobStatus(jobId, 'completed', {});
      if (completeSuccess) {
        runner.addResult('Job Updates', 'pass', 'Job status updates successful', false, 'integration');
      } else {
        runner.addResult('Job Updates', 'fail', 'Failed to complete job', false, 'integration');
      }
    } else {
      runner.addResult('Job Updates', 'fail', 'Failed to update job to running', false, 'integration');
    }
  } catch (e: any) {
    runner.addResult('Job Creation', 'fail', `Error: ${e.message}`, true, 'integration');
  }
}

// Cross-Repository Portability Tests
async function testCrossRepoPortability(runner: TestRunner, config: TestConfig) {
  console.log('\n🌐 CROSS-REPOSITORY PORTABILITY TESTS');
  console.log('-'.repeat(50));

  try {
    const github = new GitHubActionsService(config.githubToken, config.owner, config.repo, config.workflowFile, config.branch);
    const workflowDetails = await github.getWorkflowDetails();
    
    const workflowUrl = `https://api.github.com/repos/${config.owner}/${config.repo}/contents/.github/workflows/${workflowDetails.path.split('/').pop()}?ref=${config.branch}`;
    const response = await fetch(workflowUrl, {
      headers: { 'Authorization': `token ${config.githubToken}` }
    });
    
    if (response.ok) {
      const fileData = await response.json() as { content: string };
      const workflowContent = Buffer.from(fileData.content, 'base64').toString('utf8');
      const doc = yaml.load(workflowContent) as any;
      
      const inputs = doc?.on?.workflow_dispatch?.inputs;
      if (inputs && inputs.service) {
        runner.addResult('Service Input Discovery', 'pass', 'Can discover service input from workflow', true, 'portability');
        
        if (inputs.service.type === 'choice' && inputs.service.options) {
          const services = inputs.service.options;
          runner.addResult('Predefined Service Options', 'pass', `Found ${services.length} services`, false, 'portability');
        } else {
          runner.addResult('Predefined Service Options', 'skip', 'Service input not using choice type', false, 'portability');
        }
      } else {
        runner.addResult('Service Input Discovery', 'fail', 'Cannot find service input in workflow', true, 'portability');
      }
    } else {
      runner.addResult('Service Input Discovery', 'fail', 'Cannot read workflow from GitHub API', true, 'portability');
    }
  } catch (error) {
    runner.addResult('Service Input Discovery', 'fail', `Error: ${error}`, true, 'portability');
  }

  // Test environment parsing
  const testEnvironments = ['dev', 'development', 'staging', 'prod', 'production'];
  let envTestsPassed = 0;
  for (const env of testEnvironments) {
    try {
      const result = await parseCommand({
        command: `deploy frontend to ${env}`,
        hfApiKey: config.hfApiKey || null,
        confidenceThreshold: 0.4
      });
      
      if (result.environment) {
        envTestsPassed++;
        runner.addResult(`Environment: ${env}`, 'pass', `Parsed as ${result.environment}`, false, 'portability');
      } else {
        runner.addResult(`Environment: ${env}`, 'fail', `Failed to parse environment`, false, 'portability');
      }
    } catch (error) {
      runner.addResult(`Environment: ${env}`, 'fail', `Error: ${error}`, false, 'portability');
    }
  }

  // Test service patterns
  const testServices = ['api', 'frontend', 'backend', 'database', 'user-service'];
  let serviceTestsPassed = 0;
  for (const service of testServices) {
    try {
      const result = await parseCommand({
        command: `restart ${service}`,
        hfApiKey: config.hfApiKey || null,
        confidenceThreshold: 0.4
      });
      
      if (result.action === 'restart' && result.service) {
        serviceTestsPassed++;
        runner.addResult(`Service Pattern: ${service}`, 'pass', `Extracted: ${result.service}`, false, 'portability');
      } else {
        runner.addResult(`Service Pattern: ${service}`, 'fail', `Failed to parse service`, false, 'portability');
      }
    } catch (error) {
      runner.addResult(`Service Pattern: ${service}`, 'fail', `Error: ${error}`, false, 'portability');
    }
  }
}

// NLU Service Tests
async function testNluService(runner: TestRunner, config: TestConfig) {
  console.log('\n🧠 NLU SERVICE TESTS');
  console.log('-'.repeat(50));
  
  const testCases = [
    { input: 'deploy frontend to staging', expectedAction: 'deploy', expectedService: 'frontend', expectedEnvironment: 'staging' },
    { input: 'scale api-service to 3 replicas', expectedAction: 'scale', expectedService: 'api-service', expectedReplicas: 3 },
    { input: 'restart user-service', expectedAction: 'restart', expectedService: 'user-service' },
    { input: 'rollback auth-service', expectedAction: 'rollback', expectedService: 'auth-service' },
    { input: 'show logs for database', expectedAction: 'logs' },
    { input: 'check status', expectedAction: 'status' },
  ];

  let passed = 0;
  for (const tc of testCases) {
    try {
      const result = await parseCommand({
        command: tc.input,
        hfApiKey: config.hfApiKey || null,
        confidenceThreshold: 0.4
      });
      
      const actionMatch = result.action === tc.expectedAction;
      const serviceMatch = !tc.expectedService || result.service === tc.expectedService;
      const envMatch = !tc.expectedEnvironment || result.environment === tc.expectedEnvironment;
      const replicasMatch = !tc.expectedReplicas || result.replicas === tc.expectedReplicas;

      if (actionMatch && serviceMatch && envMatch && replicasMatch) {
        passed++;
        runner.addResult(`NLU: "${tc.input}"`, 'pass', `Parsed correctly (${Math.round(result.confidence * 100)}%)`, false, 'nlu-robustness');
      } else {
        runner.addResult(`NLU: "${tc.input}"`, 'fail', `Expected ${tc.expectedAction}, got ${result.action}`, false, 'nlu-robustness');
      }
    } catch (e: any) {
      runner.addResult(`NLU: "${tc.input}"`, 'fail', `Error: ${e.message}`, false, 'nlu-robustness');
    }
  }

  const accuracy = (passed / testCases.length) * 100;
  if (accuracy >= 80) {
    runner.addResult('NLU Accuracy', 'pass', `${accuracy.toFixed(1)}% (${passed}/${testCases.length})`, true, 'nlu-robustness');
  } else {
    runner.addResult('NLU Accuracy', 'fail', `${accuracy.toFixed(1)}% - need 80%+`, true, 'nlu-robustness');
  }
}

// Workflow Dispatch Tests
async function testWorkflowDispatch(runner: TestRunner, config: TestConfig) {
  console.log('\n🚀 WORKFLOW DISPATCH TESTS');
  console.log('-'.repeat(50));

  const github = new GitHubActionsService(config.githubToken, config.owner, config.repo, config.workflowFile, config.branch);
  
  const testInputs = {
    job_id: `test-${Date.now()}`,
    action: 'status',
    service: 'test-service',
    environment: 'development',
    replicas: '1',
    user_id: config.userId,
    original_command: 'test dispatch'
  };

  try {
    const dryRunResult = await github.dryRunDispatch(testInputs);
    if (dryRunResult && dryRunResult.valid) {
      runner.addResult('Dry Run Dispatch', 'pass', `Workflow ${dryRunResult.workflow_id} validated`, true, 'integration');
    } else {
      runner.addResult('Dry Run Dispatch', 'fail', 'Validation failed', true, 'integration');
    }

    if (config.liveDispatch) {
      console.log('🔥 Live dispatch enabled - triggering real workflow...');
      const runId = await github.dispatchWorkflow(testInputs);
      runner.addResult('Live Dispatch', 'pass', `Triggered run ${runId}`, false, 'integration');
    } else {
      runner.addResult('Live Dispatch', 'skip', 'Set DCH_LIVE_DISPATCH=1 to enable', false, 'integration');
    }
  } catch (error) {
    runner.addResult('Dispatch Capabilities', 'fail', `Error: ${error}`, true, 'integration');
  }
}

// Main test runner
async function runTests() {
  await ensureFetch();
  const runner = new TestRunner();
  const config = validateConfig();

  if (!config) {
    runner.printSummary();
    process.exit(1);
  }

  console.log('\n🎯 RUNNING COMPREHENSIVE INTEGRATION TESTS\n');

  // Phase 1: Core functionality
  console.log('📍 PHASE 1: Core Functionality');
  await testEnvironmentSetup(runner, config);
  await testGitHubAuth(runner, config);
  await testSupabaseIntegration(runner, config);

  // Phase 2: Cross-repository portability
  console.log('\n📍 PHASE 2: Cross-Repository Portability');
  await testCrossRepoPortability(runner, config);

  // Phase 3: NLU robustness
  console.log('\n📍 PHASE 3: NLU Service');
  await testNluService(runner, config);

  // Phase 4: Workflow dispatch
  console.log('\n📍 PHASE 4: Workflow Dispatch');
  await testWorkflowDispatch(runner, config);

  const isReady = runner.printSummary();
  process.exit(isReady ? 0 : 1);
}

runTests();