// src/backend/src/eval/evaluateIntents.ts
// Measures the intent-parsing layer against intents.labeled.json and tunes the confidence threshold.
//
//   npm run eval:intents                 # zero-shot, single-label
//   npm run eval:intents -- --multi-label
//
// Each command ends in one of two outcomes: EXECUTE <action> or ASK the user to confirm.
// A decision is correct when it executes the labeled action, or asks for an "unknown"
// (out-of-scope) command. The threshold is chosen on the dev split and reported on the
// held-out test split. Model scores are cached in .cache/ so re-runs don't call the API.
//
// Two levels are reported:
//   action-only : the confidence gate alone (decideAction)
//   end-to-end  : what the API actually does - it also refuses to run without the required
//                 slots (e.g. a service for deploy), asking the user instead. Threshold is tuned on this.
import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';
dotenv.config({ path: path.resolve(__dirname, '../../.env') });

import { createHash } from 'crypto';
import { classifyActions, decideAction, regexParse, ZERO_SHOT_LABEL_SET, type RankedAction } from '../services/nluService';
import { validateIntent, type ParsedIntent as SlotIntent } from '../services/commandParser';

type Label = 'deploy' | 'rollback' | 'scale' | 'restart' | 'logs' | 'status' | 'unknown';
type Item = { text: string; action: Label; split: 'dev' | 'test' };
type Outcome = { kind: 'execute'; action: string } | { kind: 'ask' };

type Metrics = {
  n: number;
  accuracy: number;          // correct decisions / n
  wrongExecutions: number;   // executed the wrong action, or executed an out-of-scope command
  askedInScope: number;      // in-scope commands deferred to the user (safe, but not automatic)
  coverage: number;          // share of in-scope commands executed automatically
};

const args = process.argv.slice(2);
const multiLabel = args.includes('--multi-label');
const model = (process.env.HF_MODEL || 'facebook/bart-large-mnli').trim();
const apiKey = process.env.HF_API_KEY;
if (!apiKey) {
  console.error('HF_API_KEY is required (src/backend/.env)');
  process.exit(1);
}

const items: Item[] = JSON.parse(fs.readFileSync(path.join(__dirname, 'intents.labeled.json'), 'utf8'));
const cacheDir = path.join(__dirname, '.cache');
const labelHash = createHash('sha1').update(ZERO_SHOT_LABEL_SET).digest('hex').slice(0, 8);
const cacheFile = path.join(cacheDir, `${model.replace(/\W+/g, '_')}_${labelHash}${multiLabel ? '_multi' : ''}.json`);

async function scoreAll(): Promise<Record<string, RankedAction[]>> {
  const cache: Record<string, RankedAction[]> = fs.existsSync(cacheFile) ? JSON.parse(fs.readFileSync(cacheFile, 'utf8')) : {};
  const todo = items.filter(i => !cache[i.text]);
  if (todo.length) {console.log(`Scoring ${todo.length} commands with ${model}${multiLabel ? ' (multi-label)' : ''}...`);}
  const CONCURRENCY = 4;
  for (let i = 0; i < todo.length; i += CONCURRENCY) {
    await Promise.all(todo.slice(i, i + CONCURRENCY).map(async item => {
      for (let attempt = 1; ; attempt++) {
        try {
          cache[item.text] = await classifyActions(item.text, apiKey!, { model, multiLabel });
          return;
        } catch (e: any) {
          if (attempt >= 3) {throw e;}
          await new Promise(r => setTimeout(r, 2000 * attempt));
        }
      }
    }));
    process.stdout.write(`  ${Math.min(i + CONCURRENCY, todo.length)}/${todo.length}\r`);
  }
  fs.mkdirSync(cacheDir, { recursive: true });
  fs.writeFileSync(cacheFile, JSON.stringify(cache, null, 1));
  return cache;
}

function measure(subset: Item[], decide: (item: Item) => Outcome): Metrics {
  let correct = 0, wrong = 0, askedInScope = 0, executedInScope = 0;
  const inScope = subset.filter(i => i.action !== 'unknown').length;
  for (const item of subset) {
    const o = decide(item);
    if (o.kind === 'ask') {
      if (item.action === 'unknown') {correct++;} else {askedInScope++;}
    } else if (o.action === item.action) {
      correct++; executedInScope++;
    } else {
      wrong++;
    }
  }
  return {
    n: subset.length,
    accuracy: correct / subset.length,
    wrongExecutions: wrong,
    askedInScope,
    coverage: inScope ? executedInScope / inScope : 0,
  };
}

const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
const row = (name: string, m: Metrics) =>
  `${name.padEnd(38)} ${pct(m.accuracy).padStart(7)} ${String(m.wrongExecutions).padStart(6)} ${String(m.askedInScope).padStart(6)} ${pct(m.coverage).padStart(9)}`;
const header = `${'policy'.padEnd(38)} ${'acc'.padStart(7)} ${'wrong'.padStart(6)} ${'asked'.padStart(6)} ${'coverage'.padStart(9)}`;

async function main() {
  const scores = await scoreAll();
  const dev = items.filter(i => i.split === 'dev');
  const test = items.filter(i => i.split === 'test');

  const gated = (t: number) => (item: Item): Outcome => {
    const d = decideAction(scores[item.text], item.text.toLowerCase(), t);
    return d.needs_confirmation ? { kind: 'ask' } : { kind: 'execute', action: d.action };
  };
  const withSlots = (decide: (i: Item) => Outcome) => (item: Item): Outcome => {
    const o = decide(item);
    if (o.kind === 'ask') {return o;}
    const slots = regexParse(item.text.toLowerCase());
    const { ok } = validateIntent({ ...slots, action: o.action } as SlotIntent);
    return ok ? o : { kind: 'ask' };
  };
  const endToEnd = (t: number) => withSlots(gated(t));

  // ---- sweep thresholds on dev ----
  const thresholds = Array.from({ length: 19 }, (_, i) => Number((0.05 * (i + 1)).toFixed(2)));
  const sweep = thresholds.map(t => ({ t, dev: measure(dev, endToEnd(t)) }));
  // best dev accuracy; ties broken by fewer wrong executions, then the stricter threshold
  const best = [...sweep].sort((a, b) =>
    b.dev.accuracy - a.dev.accuracy || a.dev.wrongExecutions - b.dev.wrongExecutions || b.t - a.t)[0];

  console.log(`\nModel: ${model}${multiLabel ? ' (multi-label)' : ''}   dev=${dev.length} test=${test.length}`);
  console.log('\nThreshold sweep (dev split, end-to-end):');
  console.log(`${'threshold'.padEnd(10)} ${'acc'.padStart(7)} ${'wrong'.padStart(6)} ${'asked'.padStart(6)} ${'coverage'.padStart(9)}`);
  for (const s of sweep) {
    console.log(`${s.t.toFixed(2).padEnd(10)} ${pct(s.dev.accuracy).padStart(7)} ${String(s.dev.wrongExecutions).padStart(6)} ${String(s.dev.askedInScope).padStart(6)} ${pct(s.dev.coverage).padStart(9)}${s === best ? '  <- selected' : ''}`);
  }

  // ---- held-out test ----
  const baselines: Array<[string, (i: Item) => Outcome]> = [
    ['regex only, always executes (old)', i => {
      const a = regexParse(i.text.toLowerCase()).action;
      return a === 'unknown' ? { kind: 'ask' } : { kind: 'execute', action: a };
    }],
    ['grammar only (no model)', i => {
      const d = decideAction(null, i.text.toLowerCase(), 1);
      return d.needs_confirmation ? { kind: 'ask' } : { kind: 'execute', action: d.action };
    }],
    ['model top-1, no threshold', i => {
      const top = scores[i.text][0].action;
      return top === 'unknown' ? { kind: 'ask' } : { kind: 'execute', action: top };
    }],
    [`action-only gate @ ${best.t.toFixed(2)}`, gated(best.t)],
    [`END-TO-END (gate + slots) @ ${best.t.toFixed(2)}`, endToEnd(best.t)],
  ];

  console.log('\nHeld-out test split:');
  console.log(header);
  const testResults = baselines.map(([name, fn]) => ({ name, metrics: measure(test, fn) }));
  for (const r of testResults) {console.log(row(r.name, r.metrics));}

  const inScopeTest = test.filter(i => i.action !== 'unknown');
  const top1 = inScopeTest.filter(i => scores[i.text][0].action === i.action).length / inScopeTest.length;
  console.log(`\nModel top-1 accuracy on in-scope test commands: ${pct(top1)}`);

  const selected = testResults[testResults.length - 1].metrics;
  const misses = test
    .map(i => ({ i, o: endToEnd(best.t)(i) }))
    .filter(({ i, o }) => (o.kind === 'execute' && o.action !== i.action) || (o.kind === 'ask' && i.action !== 'unknown'));
  console.log('\nTest-split errors at the selected threshold:');
  for (const { i, o } of misses) {
    console.log(`  [${i.action}] "${i.text}" -> ${o.kind === 'ask' ? 'asked user' : `EXECUTED ${o.action}`}`);
  }

  const out = {
    generated_at: new Date().toISOString(),
    model, multi_label: multiLabel,
    dataset: { total: items.length, dev: dev.length, test: test.length },
    selected_threshold: best.t,
    dev_sweep: sweep,
    test: Object.fromEntries(testResults.map(r => [r.name, r.metrics])),
    test_model_top1_in_scope: top1,
    test_accuracy_end_to_end: selected.accuracy,
    test_wrong_executions_end_to_end: selected.wrongExecutions,
  };
  const outFile = path.join(__dirname, `results${multiLabel ? '.multi-label' : ''}.json`);
  fs.writeFileSync(outFile, JSON.stringify(out, null, 1));
  console.log(`\nSaved ${path.relative(process.cwd(), outFile)}`);
}

main().catch(e => { console.error(e); process.exit(1); });
