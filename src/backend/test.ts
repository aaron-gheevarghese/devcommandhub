// Add this at the very top of your test.ts file, before any imports:
console.log('🚀 Test script starting...');
console.log('Current working directory:', process.cwd());
console.log('Script file location:', __filename);

// Add error handlers immediately
process.on('unhandledRejection', (reason, promise) => {
  console.error('🚨 Unhandled Promise Rejection:');
  console.error('Promise:', promise);
  console.error('Reason:', reason);
  process.exit(1);
});

process.on('uncaughtException', (error) => {
  console.error('🚨 Uncaught Exception:');
  console.error('Error:', error);
  console.error('Stack:', error.stack);
  process.exit(1);
});

console.log('📋 Error handlers set up');

// Then continue with your existing code...
import dotenv from 'dotenv';
import path from 'path';

console.log('📦 Basic imports successful');

// Test environment loading
console.log('🔧 Loading environment...');
const envPath = path.resolve(__dirname, '.env');
console.log('Environment file path:', envPath);

// Load environment
const envResult = dotenv.config({ path: envPath });
if (envResult.error) {
  console.log('⚠️ Could not load .env file:', envResult.error.message);
  // Try alternative path
  const altEnvPath = path.resolve(__dirname, '../.env');
  console.log('Trying alternative path:', altEnvPath);
  dotenv.config({ path: altEnvPath });
} else {
  console.log('✅ Environment loaded successfully');
}

console.log('🔑 Checking critical env vars...');
console.log('TEST_USER_ID:', process.env.TEST_USER_ID ? '✅ Set' : '❌ Missing');
const token =
  process.env.GITHUB_API_KEY ||
  process.env.GH_TOKEN ||
  process.env.GITHUB_TOKEN;

console.log('GitHub token available:', token ? '✅ Yes' : '❌ Missing');

console.log('HF_API_KEY:', process.env.HF_API_KEY ? '✅ Set' : '❌ Missing');

console.log('📦 Attempting service imports...');

// Rest of your existing imports and code...
import { GitHubActionsService, mapGaToDchStatus } from './src/services/githubService';
import { supabaseService } from './src/services/supabase';
import { parseCommand } from './src/services/nluService';

const TEST_USER_ID = process.env.TEST_USER_ID;
const GITHUB_TOKEN = process.env.GITHUB_API_KEY;
const WORKFLOW_FILE =
  process.env.GH_WORKFLOW_FILE ||
  process.env.GH_OPS_WORKFLOW_FILE ||
  'ops.yml';


async function testGitHubService() {
  console.log('\n🔧 Testing GitHub Service...');
  if (!GITHUB_TOKEN) {
    console.error('❌ GITHUB_API_KEY not set in environment');
    return false;
  }
  try {
    const service = new GitHubActionsService();
    await service.authenticate(GITHUB_TOKEN);
    console.log('✅ GitHub authentication successful');
    // Test workflow file exists
    try {
      const workflows = await service.listWorkflows();
      console.log('Available workflows:', workflows.map(w => `${w.name} (${w.path}) [${w.id}]`));
      const targetWorkflow = workflows.find(
        w => w.path.endsWith(String(WORKFLOW_FILE)) ||
             w.id === Number(WORKFLOW_FILE) ||
             w.name === 'DevCommandHub Ops'
      );
      if (targetWorkflow) {
        console.log(`Found workflow: ${targetWorkflow.name} ${targetWorkflow.path} id=${targetWorkflow.id}`);
      } else {
        console.log(`Could not find workflow for ${WORKFLOW_FILE}`);
      }
    } catch (error) {
      console.log(`⚠️ Could not list workflows: ${error instanceof Error ? error.message : error}`);
    }
    return true;
  } catch (error) {
    console.error('❌ GitHub service test failed:', error instanceof Error ? error.message : error);
    return false;
  }
}

async function testSupabaseConnection() {
  console.log('\n🗄️  Testing Supabase Connection...');
  
  try {
    const isConnected = await supabaseService.testConnection();
    if (isConnected) {
      console.log('✅ Supabase connection successful');
      return true;
    } else {
      console.error('❌ Supabase connection failed');
      return false;
    }
  } catch (error) {
    console.error('❌ Supabase test failed:', error instanceof Error ? error.message : error);
    return false;
  }
}

async function testNLUParsing() {
  console.log('\n🧠 Testing NLU Parsing...');
  
  const testCommands = [
    'deploy frontend to staging',
    'scale api-service to 3 replicas',
    'restart user-service',
    'rollback auth-service',
    'show logs for database-service'
  ];

  for (const command of testCommands) {
    try {
      const result = await parseCommand({ 
        command, 
        hfApiKey: process.env.HF_API_KEY ?? null,
        confidenceThreshold: 0.6 
      });
      
      console.log(`✅ "${command}"`);
      console.log(`   Action: ${result.action}, Service: ${result.service || 'none'}`);
      console.log(`   Confidence: ${(result.confidence * 100).toFixed(1)}%, Source: ${result.source}`);
    } catch (error) {
      console.log(`❌ "${command}" - ${error instanceof Error ? error.message : error}`);
    }
  }
}

async function testJobCreation() {
  console.log('\n📋 Testing Job Creation...');
  
  if (!TEST_USER_ID) {
    console.error('❌ TEST_USER_ID not set in environment');
    return null;
  }

  try {
    const result = await supabaseService.createJob({
      user_id: TEST_USER_ID,
      original_command: 'test command from integration test',
      parsed_intent: {
        action: 'status',
        service: 'test-service',
        environment: 'development',
        confidence: 1.0,
        source: 'test'
      },
      job_type: 'status'
    });

    if (result.error || !result.data) {
      console.error('❌ Job creation failed:', result.error);
      return null;
    }

    console.log(`✅ Job created with ID: ${result.data.id}`);
    return result.data;
  } catch (error) {
    console.error('❌ Job creation test failed:', error instanceof Error ? error.message : error);
    return null;
  }
}

async function testWorkflowDispatch(dryRun = true) {
  console.log(`\n🚀 Testing Workflow Dispatch (${dryRun ? 'DRY RUN' : 'LIVE'})...`);
  
  if (!GITHUB_TOKEN) {
    console.error('❌ Cannot test dispatch without GITHUB_TOKEN');
    return false;
  }

  if (dryRun) {
    console.log('🔒 Dry run mode - would dispatch workflow with these inputs:');
    const inputs = {
      job_id: 'test-job-id',
      action: 'status',
      service: 'test-service',
      environment: 'development',
      replicas: '1',
      user_id: TEST_USER_ID || 'test-user',
      original_command: 'status test-service'
    };
    
    console.log('   Inputs:', JSON.stringify(inputs, null, 2));
    console.log('   Workflow file:', WORKFLOW_FILE);
    return true;
  }

  // Actual dispatch (use with caution)
  try {
    const service = new GitHubActionsService();
    await service.authenticate(GITHUB_TOKEN);
    
    await service.dispatch(WORKFLOW_FILE, {
      job_id: 'test-dispatch-' + Date.now(),
      action: 'status',
      service: 'test-service',
      environment: 'development',
      replicas: '1',
      user_id: TEST_USER_ID || 'test-user',
      original_command: 'test workflow dispatch'
    });
    
    console.log('✅ Workflow dispatch successful');
    return true;
  } catch (error) {
    console.error('❌ Workflow dispatch failed:', error instanceof Error ? error.message : error);
    return false;
  }
}

async function testStatusMapping() {
  console.log('\n📊 Testing Status Mapping...');
  
  const testCases = [
    { status: 'queued', conclusion: null, expected: 'running' },
    { status: 'in_progress', conclusion: null, expected: 'running' },
    { status: 'completed', conclusion: 'success', expected: 'completed' },
    { status: 'completed', conclusion: 'failure', expected: 'failed' },
    { status: 'completed', conclusion: 'cancelled', expected: 'cancelled' },
  ];
  
  for (const testCase of testCases) {
    const result = mapGaToDchStatus(testCase.status as any, testCase.conclusion as any);
    const passed = result === testCase.expected;
    console.log(`${passed ? '✅' : '❌'} ${testCase.status}/${testCase.conclusion} -> ${result} (expected: ${testCase.expected})`);
  }
}

async function runAllTests() {
  console.log('🧪 DevCommandHub GitHub Actions Integration Test');
  console.log('================================================');
  
  const results = {
    supabase: await testSupabaseConnection(),
    github: await testGitHubService(),
    nlu: true, // NLU test doesn't return boolean
    jobCreation: null as any,
    statusMapping: true
  };
  
  await testNLUParsing();
  results.jobCreation = await testJobCreation();
  testStatusMapping();
  
  console.log('\n📋 Test Summary:');
  console.log(`Supabase: ${results.supabase ? '✅' : '❌'}`);
  console.log(`GitHub: ${results.github ? '✅' : '❌'}`);
  console.log(`Job Creation: ${results.jobCreation ? '✅' : '❌'}`);
  
  // Workflow dispatch test (dry run by default)
  const shouldTestDispatch = process.argv.includes('--dispatch');
  const dryRun = !process.argv.includes('--live');
  
  if (shouldTestDispatch) {
    await testWorkflowDispatch(dryRun);
  } else {
    console.log('\n💡 To test workflow dispatch, run with --dispatch flag');
    console.log('   Add --live flag to actually dispatch (use carefully!)');
  }
  
  const allPassed = results.supabase && results.github && results.jobCreation;
  
  if (allPassed) {
    console.log('\n🎉 All core tests passed! GitHub Actions integration should work.');
  } else {
    console.log('\n⚠️  Some tests failed. Fix these issues before proceeding.');
  }
  
  // Clean up test job if created
  if (results.jobCreation) {
    console.log(`\n🧹 Cleaning up test job ${results.jobCreation.id}`);
    // Note: You might want to add a cleanup method to supabaseService
  }
}

// Replace the last line of your test.ts file with this:
console.log('🏃 About to run all tests...');

// Wrap execution in try-catch
async function safeExecute() {
  try {
    await runAllTests();
    console.log('🎉 Test execution completed successfully');
  } catch (error) {
    console.error('💥 Error during test execution:');
    console.error('Type:', typeof error);
    console.error('Error:', error);
    if (error instanceof Error) {
      console.error('Message:', error.message);
      console.error('Stack:', error.stack);
    }
    process.exit(1);
  }
}

safeExecute();