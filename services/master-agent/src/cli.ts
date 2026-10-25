#!/usr/bin/env node
import * as fs from 'node:fs';
import * as os from 'node:os';
import process from 'node:process';
import { assertTransition, type CandidateStatus } from '@csn/core';
import { AdapterRegistry, getBuiltinAdapters } from '@csn/adapters';
import { runAudit, flattenAudit } from '@csn/discovery';
import { loadPolicy, type CsnPolicy } from '@csn/policy';
import { intake, submissionHash, type Candidate, type SubmissionEnvelope } from './intake.js';
import { evaluateCandidate, type EvaluationContext } from './evaluate.js';
import { loadStore, saveStore, defaultStoreFilePath, masterDataDir } from './store.js';
import { planResearch, applyResearchFindings, type ResearchFindings } from './research.js';
import { buildValidationPlan, runDetachedValidation } from './validation.js';
import { buildProposal } from './proposal.js';
import { proposeCandidate, integrateCandidate, rollbackCandidate } from './pipeline.js';

/**
 * Master Agent CLI — private tooling, manual-operator only.
 * No command schedules anything; no command sends anything anywhere.
 */

interface ParsedArgs {
  command: string;
  positional: string[];
  flags: Record<string, string | boolean>;
}

function parseArgs(argv: string[]): ParsedArgs {
  const [command = 'help', ...rest] = argv;
  const flags: Record<string, string | boolean> = {};
  const positional: string[] = [];
  for (const arg of rest) {
    if (arg.startsWith('--')) {
      const without = arg.slice(2);
      const eq = without.indexOf('=');
      if (eq >= 0) flags[without.slice(0, eq)] = without.slice(eq + 1);
      else flags[without] = true;
    } else {
      positional.push(arg);
    }
  }
  return { command, positional, flags };
}

const HELP = `csn-master — local candidate pipeline (intake → compare → score → validate → propose)

  npm run master intake      <report.json>      stage a sanitized capability report (file on disk)
  npm run master evaluate    [candidateId]      compare with local audit + score (explainable)
  npm run master research    <candidateId>      print a research checklist (declared-level only)
  npm run master research-apply <candidateId> <findings.json>  apply verified findings
  npm run master plan        <candidateId>      show the detached-validation plan (runs nothing)
  npm run master validate    <candidateId> --command "node check.js"  run gated detached validation
  npm run master propose     <candidateId>      generate the integration proposal markdown
  npm run master accept      <candidateId> --confirm   human gate: integration-proposed → integrated-verified
  npm run master rollback    <candidateId>      integrated-verified → rolled-back
  npm run master list        [--status X]       list candidates with honest statuses
  npm run master stats                          store summary
Store: ${defaultStoreFilePath()}  (overridable: CSN_MASTER_DATA_DIR)`;

function storeOptions() {
  return { dataDir: process.env.CSN_MASTER_DATA_DIR ?? masterDataDir() };
}

async function localRegistrySnapshot(): Promise<{ capabilities: { name: string; category: string; description?: string }[]; envCount: number }> {
  const registry = new AdapterRegistry(getBuiltinAdapters());
  const audit = await runAudit({ homeRoot: os.homedir() }, registry);
  return { capabilities: flattenAudit(audit).map((r) => ({ name: r.name, category: r.category, description: r.description })), envCount: audit.environments.length };
}

async function evaluateOne(candidate: Candidate, context: EvaluationContext): Promise<Candidate> {
  const updated = evaluateCandidate(candidate, context);
  const data = loadStore(storeOptions());
  const index = data.candidates.findIndex((c) => c.id === updated.id);
  if (index >= 0) data.candidates[index] = updated;
  saveStore(data, storeOptions());
  return updated;
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  const dataDir = storeOptions();

  switch (args.command) {
    case 'help':
    case undefined: {
      console.log(HELP);
      return 0;
    }

    case 'intake': {
      const file = args.positional[0];
      if (!file) {
        console.error('error: provide a report JSON file path (a sanitized CSN report, not a raw capability dump)');
        return 1;
      }
      let raw: string;
      try {
        raw = fs.readFileSync(file, 'utf8');
      } catch (err) {
        console.error(`error: cannot read ${file}: ${err instanceof Error ? err.message : String(err)}`);
        return 1;
      }
      let payload: unknown;
      try {
        payload = JSON.parse(raw);
      } catch (err) {
        console.error(`error: not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
        return 1;
      }
      const data = loadStore(dataDir);
      const envelope: SubmissionEnvelope = {
        installationId: typeof (payload as { installationId?: unknown })?.installationId === 'string' ? String((payload as { installationId?: unknown }).installationId) : 'ins_manual',
        receivedAt: new Date().toISOString(),
        payload,
      };
      const result = intake(envelope, data.candidates);
      data.candidates.push(...result.newCandidates);
      saveStore(data, dataDir);
      console.log(`intake: accepted=${result.accepted} deduplicated=${result.deduplicated} rejected=${result.rejected.length} (payload hash ${submissionHash(envelope.payload)})`);
      for (const candidate of result.newCandidates) {
        console.log(`  + ${candidate.id}  ${candidate.capability.name}  [${candidate.status}, untrusted]`);
      }
      for (const r of result.rejected) console.log(`  - rejected: ${r}`);
      for (const i of result.issues) console.log(`  ! ${i}`);
      return result.accepted > 0 ? 0 : result.rejected.some((r) => r.startsWith('schema:')) ? 2 : 0;
    }

    case 'evaluate': {
      const data = loadStore(dataDir);
      const targets = args.positional[0] ? data.candidates.filter((c) => c.id === args.positional[0]) : data.candidates.filter((c) => c.status === 'reported' || c.status === 'research-pending');
      if (targets.length === 0) {
        console.log('nothing to evaluate (no reported/research-pending candidates — use `list --all`)');
        return 0;
      }
      console.log('auditing the local machine (read-only) to build the comparison registry…');
      const snapshot = await localRegistrySnapshot();
      console.log(`local registry: ${snapshot.capabilities.length} capabilities across ${snapshot.envCount} environment(s)`);
      for (const candidate of targets) {
        const updated = await evaluateOne(candidate, { local: snapshot.capabilities });
        console.log(`${updated.id}  ${updated.capability.name}`);
        console.log(`  local: ${updated.localStatus} · score ${updated.scoreSummary?.total ?? 'n/a'} → ${updated.scoreSummary?.suggestedStatus ?? 'n/a'} · status ${updated.status}`);
        for (const gate of updated.scoreSummary?.gates ?? []) console.log(`  gate: ${gate}`);
      }
      return 0;
    }

    case 'research': {
      const data = loadStore(dataDir);
      const candidate = data.candidates.find((c) => c.id === args.positional[0]);
      if (!candidate) {
        console.error(`error: unknown candidate '${args.positional[0] ?? ''}'`);
        return 1;
      }
      const checklist = planResearch(candidate);
      console.log(`research checklist for ${candidate.id} (${candidate.capability.name})`);
      console.log(`evidence ceiling for research: '${checklist.evidenceCeiling}' — research can never mint 'tested' evidence\n`);
      console.log('sources:');
      for (const source of checklist.sources) console.log(`  [${source.kind}] ${source.reference}: ${source.note}`);
      console.log('checks:');
      for (const check of checklist.checks) console.log(`  ☐ ${check}`);
      return 0;
    }

    case 'research-apply': {
      const [id, findingsFile] = args.positional;
      if (!id || !findingsFile) {
        console.error('error: usage: research-apply <candidateId> <findings.json>');
        return 1;
      }
      const data = loadStore(dataDir);
      const candidate = data.candidates.find((c) => c.id === id);
      if (!candidate) {
        console.error(`error: unknown candidate '${id}'`);
        return 1;
      }
      const findings = JSON.parse(fs.readFileSync(findingsFile, 'utf8')) as ResearchFindings;
      const result = applyResearchFindings(candidate, findings);
      saveStore(data, dataDir);
      console.log(`research applied to ${id}:`);
      for (const change of result.changes) console.log(`  • ${change}`);
      console.log(`status: ${result.statusAfter}`);
      return 0;
    }

    case 'plan': {
      const data = loadStore(dataDir);
      const candidate = data.candidates.find((c) => c.id === args.positional[0]);
      if (!candidate) {
        console.error(`error: unknown candidate '${args.positional[0] ?? ''}'`);
        return 1;
      }
      const policy: CsnPolicy = loadPolicy();
      console.log(`policy: ${policy.exec.allow ? 'exec allowed by operator' : 'exec disabled (default)'} · prefixes: ${policy.exec.allowedCommandPrefixes.join(', ') || '(none)'}`);
      const plan = buildValidationPlan(candidate, policy, typeof args.flags.command === 'string' ? [args.flags.command] : []);
      console.log(JSON.stringify(plan, null, 2));
      return plan.approved ? 0 : 3;
    }

    case 'validate': {
      const data = loadStore(dataDir);
      const candidate = data.candidates.find((c) => c.id === args.positional[0]);
      if (!candidate) {
        console.error(`error: unknown candidate '${args.positional[0] ?? ''}'`);
        return 1;
      }
      const policy: CsnPolicy = loadPolicy();
      const command = typeof args.flags.command === 'string' ? args.flags.command : undefined;
      if (!command) {
        console.error('error: pass --command "node file-check.js" — validation always needs an explicit, policy-allowlisted command');
        return 1;
      }
      const plan = buildValidationPlan(candidate, policy, [command]);
      if (!plan.approved) {
        console.error(`validation refused: ${plan.refusal}`);
        console.error(`policy context: ${plan.policySummary}`);
        return 3;
      }
      console.log(`running detached validation (timeout ${plan.timeoutMs}ms, sanitized env, throwaway cwd)…`);
      const { record } = await runDetachedValidation(plan);
      candidate.validation = record;
      // record the outcome through the transition machine
      const toStatus: CandidateStatus = record.passed ? 'testing-passed' : 'testing-failed';
      const transitionOk = (() => {
        try {
          assertTransition(candidate.status, toStatus, `detached validation ${record.passed ? 'passed' : 'failed'} (actor: validation)`);
          return true;
        } catch {
          return false;
        }
      })();
      if (transitionOk) {
        candidate.history.push({ at: new Date().toISOString(), from: candidate.status, to: toStatus, actor: 'validation', reason: `exit ${record.exitCode} in ${record.durationMs}ms` });
        candidate.status = toStatus;
        console.log(`validation ${record.passed ? 'PASSED' : 'FAILED'} → status '${toStatus}'`);
      } else {
        console.log(`validation ran; '${candidate.status}' → '${toStatus}' is not a legal transition (candidate stays put; see \`npm run master plan\`)`);
      }
      if (record.outputTail) console.log(`output tail: ${record.outputTail.slice(0, 900)}`);
      saveStore(data, dataDir);
      return record.passed ? 0 : 4;
    }

    case 'propose': {
      const data = loadStore(dataDir);
      const candidate = data.candidates.find((c) => c.id === args.positional[0]);
      if (!candidate) {
        console.error(`error: unknown candidate '${args.positional[0] ?? ''}'`);
        return 1;
      }
      const proposal = buildProposal(candidate);
      if (!proposal.canPropose) {
        console.error(`cannot propose yet: ${proposal.reason}`);
        console.error('(this refusal is by design — proposals only exist after a passed local validation)');
        return 3;
      }
      const result = proposeCandidate(candidate.id, proposal.markdown, dataDir);
      if (!result.ok) {
        console.error(`propose failed: ${result.error}`);
        return 1;
      }
      if (args.flags.out && typeof args.flags.out === 'string') {
        fs.writeFileSync(args.flags.out, proposal.markdown, 'utf8');
        console.log(`proposal written to ${args.flags.out}`);
      } else {
        console.log(proposal.markdown);
      }
      return 0;
    }

    case 'accept': {
      const id = args.positional[0];
      if (!id) {
        console.error('error: usage: accept <candidateId> --confirm');
        return 1;
      }
      if (args.flags.confirm !== true) {
        console.error('refusing: integration is a human gate — rerun with --confirm after you actually reviewed the proposal');
        return 3;
      }
      const result = integrateCandidate(id, String(args.flags.note ?? 'cli accept'), dataDir);
      if (!result.ok) {
        console.error(`accept failed: ${result.error}`);
        return 1;
      }
      console.log(`integrated '${id}' (status now ${result.candidate.status}). ${result.rollbackNote}`);
      return 0;
    }

    case 'rollback': {
      const id = args.positional[0];
      if (!id) {
        console.error('error: usage: rollback <candidateId> --confirm');
        return 1;
      }
      if (args.flags.confirm !== true) {
        console.error('refusing: rollback itself is a state change — rerun with --confirm');
        return 3;
      }
      const result = rollbackCandidate(id, String(args.flags.note ?? 'cli rollback'), dataDir);
      if (!result.ok) {
        console.error(`rollback failed: ${result.error}`);
        return 1;
      }
      console.log(`rolled back '${id}' (status now ${result.candidate.status})`);
      return 0;
    }

    case 'list': {
      const data = loadStore(dataDir);
      let candidates = data.candidates;
      if (typeof args.flags.status === 'string') candidates = candidates.filter((c) => c.status === args.flags.status);
      if (candidates.length === 0) {
        console.log('no candidates in the store yet — intake a report file first.');
        return 0;
      }
      for (const candidate of candidates) {
        const score = candidate.scoreSummary ? `score ${candidate.scoreSummary.total} (→${candidate.scoreSummary.suggestedStatus})` : 'not scored';
        console.log(`${candidate.id.padEnd(14)} ${candidate.status.padEnd(30)} ${candidate.capability.name} · ${candidate.localStatus} · ${score}`);
      }
      console.log(`store: ${data.candidates.length} candidate(s), ${data.acceptedIntegrations.length} accepted integration(s) at ${defaultStoreFilePath(dataDir)}`);
      return 0;
    }

    case 'stats': {
      const data = loadStore(dataDir);
      const byStatus = new Map<string, number>();
      for (const candidate of data.candidates) byStatus.set(candidate.status, (byStatus.get(candidate.status) ?? 0) + 1);
      console.log('master-agent store stats');
      console.log(`  location: ${defaultStoreFilePath(dataDir)}`);
      console.log(`  candidates: ${data.candidates.length} ${byStatus.size ? `(${[...byStatus.entries()].map(([s, n]) => `${s}: ${n}`).join(', ')})` : ''}`);
      console.log(`  accepted integrations: ${data.acceptedIntegrations.length}`);
      return 0;
    }

    default:
      console.error(`unknown command: ${args.command}`);
      console.log(HELP);
      return 1;
  }
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err) => {
    console.error(`fatal: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
    process.exitCode = 1;
  });