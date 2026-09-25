#!/usr/bin/env node
/*
 * Runner denylist validator and merger.
 *
 * This is the emergency brake. An operator writes a JSON body into the N8N_RUNNER_DENYLIST
 * env var; the container entrypoint pipes it through here before the runner launcher
 * starts. A denied package or node type must lose to nothing — not to the approved
 * baseline, not to the module allowlist.
 *
 * Stdlib only, single file, no dependencies — installing a validator dependency would put
 * the emergency brake downstream of the supply chain it exists to govern. Shared between
 * the main and runner images so the two cannot disagree about what a denylist means.
 *
 * Checks are hand-written rather than JSON-Schema-driven: the messages are read by a human
 * under time pressure who needs to be told what to type, not which JSON pointer failed.
 *
 * Usage:
 *   denylist.js validate      --denylist <file>
 *   denylist.js merge         --denylist <file> --config <file> [--out <file>]
 *   denylist.js nodes-exclude --denylist <file>
 *   denylist.js patterns
 *
 * Exit codes: 0 = ok, 1 = refused (invalid denylist or unusable input), 2 = usage error.
 */

'use strict';

const fs = require('fs');

/* Kept identical to the schema's `items.pattern` for packages and nodes. Asserted, not
 * assumed - see the `patterns` subcommand and its test. */
const PKG_PATTERN = '^(@[a-z0-9][a-z0-9._-]*/)?[a-z0-9][a-z0-9._-]*$';
const NODE_PATTERN = '^(@[A-Za-z0-9][A-Za-z0-9._-]*/)?[A-Za-z0-9][A-Za-z0-9-]*\\.[A-Za-z0-9]+$';

const SCHEMA_VERSION = 1;
const TOP_LEVEL_KEYS = ['version', 'packages', 'nodes', 'reason', 'added_by', 'added_at', 'approval'];
const APPROVAL_KEYS = ['mode', 'approver', 'justification'];
const APPROVAL_MODES = ['approved', 'break-glass', 'non-production', 'baseline'];
const REASON_MIN_LENGTH = 10;
const JUSTIFICATION_MIN_LENGTH = 10;

/* The allowlists a denial must be subtracted from. Enumerated rather than pattern-matched
 * on the key name: N8N_RUNNERS_ALLOW_TRANSITIVE_IMPORTS also contains "ALLOW" but holds a
 * boolean, and filtering a package name out of "true" is nonsense that would only surface
 * as a runner that silently stopped honouring transitive imports. */
/* Nodes n8n 2.x disables out of the box. Read from
 * @n8n/config/dist/configs/nodes.config.js in n8nio/n8n:2.34.6, where `exclude` is declared
 * as @Env('NODES_EXCLUDE') over this default.
 *
 * THE ENV VAR REPLACES THIS DEFAULT, IT DOES NOT EXTEND IT. So emitting only the operator's
 * blocked nodes would silently RE-ENABLE executeCommand and localFileTrigger - a denylist
 * that widens the attack surface. Every value emitted here is a union with these.
 *
 * Worse, the config parses the value with a JsonStringArray that returns [] on any JSON
 * parse failure, with no error. A comma-separated value therefore disables nothing at all
 * and looks like it worked. That is why nodes-exclude emits a JSON array and why the tests
 * assert the shape rather than just the contents.
 *
 * Re-check this list on an n8n major upgrade. */
/* Parses the incoming NODES_EXCLUDE so the merge can only ever ADD to it.
 *
 * An unparseable baseline degrades to [] with a warning rather than refusing, because that is
 * precisely what n8n itself does with the value (JsonStringArray -> [] on any parse failure).
 * Refusing here would turn a pre-existing misconfiguration, unrelated to any denylist, into a
 * container that will not boot — and this function exists because of a regression caused by
 * being clever about this value rather than faithful to it. */
function parseBaselineNodes(raw) {
  if (raw === undefined || raw === null || String(raw).trim() === '') return [];
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    process.stderr.write(
      '[denylist] WARNING: NODES_EXCLUDE baseline is not valid JSON (' + e.message +
        '); treating it as [], which is what n8n does with it too.\n');
    return [];
  }
  if (!Array.isArray(parsed) || !parsed.every((x) => typeof x === 'string')) {
    process.stderr.write(
      '[denylist] WARNING: NODES_EXCLUDE baseline is not a JSON array of strings; treating it as [].\n');
    return [];
  }
  return [...parsed];
}

const ALLOWLIST_KEYS = [
  'NODE_FUNCTION_ALLOW_BUILTIN',
  'NODE_FUNCTION_ALLOW_EXTERNAL',
  'N8N_RUNNERS_STDLIB_ALLOW',
  'N8N_RUNNERS_EXTERNAL_ALLOW',
];

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/** Returns an array of human-readable problems. Empty means valid. */
function validateDenylist(body) {
  const errors = [];

  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return ['the denylist must be a JSON object (got ' + describe(body) + ')'];
  }

  for (const key of Object.keys(body)) {
    if (!TOP_LEVEL_KEYS.includes(key)) {
      errors.push('unknown property: ' + key + ' (allowed: ' + TOP_LEVEL_KEYS.join(', ') + ')');
    }
  }
  for (const key of TOP_LEVEL_KEYS) {
    if (!(key in body)) errors.push('missing required property: ' + key);
  }

  if ('version' in body && body.version !== SCHEMA_VERSION) {
    /* Refusing an unknown version is the point: an older entrypoint meeting a newer body
     * must stop, not silently ignore the fields it does not understand. */
    errors.push('version must be ' + SCHEMA_VERSION + ' (got ' + JSON.stringify(body.version) +
      ') - this container is too old for that denylist, or the value is a typo');
  }

  if ('packages' in body) errors.push(...checkNameArray(body.packages, 'packages', PKG_PATTERN, true));
  if ('nodes' in body) errors.push(...checkNameArray(body.nodes, 'nodes', NODE_PATTERN, false));

  if ('reason' in body) {
    if (typeof body.reason !== 'string') {
      errors.push('reason must be a string');
    } else if (body.reason.trim().length < REASON_MIN_LENGTH) {
      errors.push('reason must be at least ' + REASON_MIN_LENGTH + ' characters - state why the ' +
        'block exists so whoever reads this parameter in three months can tell an incident ' +
        'from an experiment');
    }
  }

  if ('added_by' in body && (typeof body.added_by !== 'string' || body.added_by.trim() === '')) {
    errors.push('added_by must name the operator applying the change');
  }

  if ('added_at' in body) {
    if (typeof body.added_at !== 'string' || Number.isNaN(Date.parse(body.added_at))) {
      errors.push('added_at must be an ISO 8601 date-time, e.g. ' + new Date().toISOString());
    }
  }

  if ('approval' in body) errors.push(...checkApproval(body.approval));

  /* 'baseline' is the mode Terraform seeds, and it names nobody. If it could also block
   * something, it would be a way to enforce a block with no approver and no justification -
   * making the approval field decoration in exactly the case it exists for. A cross-property
   * rule, so it cannot live inside checkApproval. */
  if (body.approval && body.approval.mode === 'baseline') {
    const blocked = (Array.isArray(body.packages) ? body.packages.length : 0) +
      (Array.isArray(body.nodes) ? body.nodes.length : 0);
    if (blocked > 0) {
      errors.push('approval.mode is "baseline", which is reserved for the empty value Terraform ' +
        'seeds and may not block anything (this one blocks ' + blocked + ') - a real block needs ' +
        'mode "approved" with an approver, or "break-glass" with a justification');
    }
  }

  return errors;
}

function checkNameArray(value, field, pattern, requireLowercase) {
  if (!Array.isArray(value)) return [field + ' must be an array (an empty array means nothing is blocked)'];
  const errors = [];
  const re = new RegExp(pattern);
  const seen = new Set();
  value.forEach((entry, i) => {
    const at = field + '[' + i + ']';
    if (typeof entry !== 'string') {
      errors.push(at + ' must be a string (got ' + describe(entry) + ')');
      return;
    }
    /* An uppercase name is a near miss, not an attack, so say what to type. Checked before
     * the pattern so the operator gets the useful message rather than a regex. */
    if (requireLowercase && entry !== entry.toLowerCase() && re.test(entry.toLowerCase())) {
      errors.push(at + ' ' + JSON.stringify(entry) + ' must be lowercase - use ' +
        JSON.stringify(entry.toLowerCase()) + ' (matching is case-insensitive, the stored form is not)');
      return;
    }
    if (!re.test(entry)) {
      /* A comma here would split into two allowlist entries and a metacharacter could
       * escape whatever consumes the merged value, so this is a security check, not
       * tidiness. */
      errors.push(at + ' ' + JSON.stringify(entry) + ' is not a valid ' +
        (field === 'nodes' ? 'fully-qualified node type (e.g. n8n-nodes-base.executeCommand)' : 'package name') +
        ' - must match ' + pattern);
      return;
    }
    const key = entry.toLowerCase();
    if (seen.has(key)) errors.push(at + ' ' + JSON.stringify(entry) + ' is a duplicate');
    seen.add(key);
  });
  return errors;
}

function checkApproval(approval) {
  if (approval === null || typeof approval !== 'object' || Array.isArray(approval)) {
    return ['approval must be an object with a mode'];
  }
  const errors = [];
  for (const key of Object.keys(approval)) {
    if (!APPROVAL_KEYS.includes(key)) errors.push('unknown property: approval.' + key);
  }
  if (!('mode' in approval)) {
    errors.push('approval.mode is required (' + APPROVAL_MODES.join(' | ') + ')');
    return errors;
  }
  if (!APPROVAL_MODES.includes(approval.mode)) {
    errors.push('approval.mode ' + JSON.stringify(approval.mode) + ' is not one of ' + APPROVAL_MODES.join(', '));
    return errors;
  }
  if (approval.mode === 'approved') {
    if (typeof approval.approver !== 'string' || approval.approver.trim() === '') {
      errors.push('approval.mode is "approved" so approval.approver must name a member of the ' +
        'n8n-admins group - if nobody approved this, use break-glass and say so');
    }
  }
  if (approval.mode === 'break-glass') {
    if (typeof approval.justification !== 'string' || approval.justification.trim().length < JUSTIFICATION_MIN_LENGTH) {
      errors.push('approval.mode is "break-glass" so approval.justification must explain why no ' +
        'approver was reachable (at least ' + JUSTIFICATION_MIN_LENGTH + ' characters) - it is ' +
        'reviewed at the next security review');
    }
  }
  return errors;
}

function describe(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'an array';
  return typeof value;
}

// ---------------------------------------------------------------------------
// Merge
// ---------------------------------------------------------------------------

/**
 * Subtracts the denied packages from every runner allowlist. Only ever narrows: nothing is
 * added, no other field is touched, and a name that is not on any allowlist is a no-op.
 */
function mergeConfig(config, denied) {
  const deniedSet = new Set(denied.map((p) => p.toLowerCase()));
  const removed = [];

  for (const runner of config['task-runners'] || []) {
    const overrides = runner['env-overrides'];
    if (!overrides) continue;
    for (const key of ALLOWLIST_KEYS) {
      if (typeof overrides[key] !== 'string') continue;
      /* Split on the separator the runner itself uses, then compare whole entries. A
       * substring replace would take `requests` out when `re` was denied. */
      const kept = overrides[key]
        .split(',')
        .map((e) => e.trim())
        .filter((e) => e !== '')
        .filter((entry) => {
          if (deniedSet.has(entry.toLowerCase())) {
            removed.push(runner['runner-type'] + '/' + key + ':' + entry);
            return false;
          }
          return true;
        });
      overrides[key] = kept.join(',');
    }
  }
  return { config, removed };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function usage(message) {
  if (message) process.stderr.write('denylist.js: ' + message + '\n');
  process.stderr.write(
    'usage: denylist.js validate      --denylist <file>\n' +
    '       denylist.js merge         --denylist <file> --config <file> [--out <file>]\n' +
    '       denylist.js nodes-exclude --denylist <file>\n' +
    '       denylist.js patterns\n');
  process.exit(2);
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 2) {
    const flag = argv[i];
    if (!flag.startsWith('--')) usage('unexpected argument: ' + flag);
    if (i + 1 >= argv.length) usage('flag ' + flag + ' needs a value');
    out[flag.slice(2)] = argv[i + 1];
  }
  return out;
}

function refuse(lines) {
  /* Everything goes to stderr and nothing usable to stdout. A caller that ignored the exit
   * code and piped stdout into a config file must end up with an empty file, never a
   * partially-filtered one. */
  process.stderr.write('DENYLIST REFUSED - this container will not start with this value:\n');
  for (const line of lines) process.stderr.write('  - ' + line + '\n');
  process.stderr.write('Contract: specs/007-runner-package-hardening/contracts/runner-denylist.schema.json\n');
  process.exit(1);
}

function readDenylist(path) {
  if (!path) usage('--denylist is required');
  let raw;
  try {
    raw = fs.readFileSync(path, 'utf8');
  } catch (e) {
    refuse(['cannot read the denylist at ' + path + ': ' + e.message]);
  }
  if (raw.trim() === '') {
    /* Distinct from "{}" on purpose: an empty value means the parameter was never seeded or
     * was truncated in transit, which is not the same as "nothing is blocked". */
    refuse(['the denylist is empty - an empty value is not the same as an empty denylist; ' +
      'the no-op body is {"version":1,"packages":[],"nodes":[],...}']);
  }
  let body;
  try {
    body = JSON.parse(raw);
  } catch (e) {
    refuse(['the denylist is not valid JSON: ' + e.message]);
  }
  const errors = validateDenylist(body);
  if (errors.length) refuse(errors);
  return body;
}

function main() {
  const [command, ...rest] = process.argv.slice(2);
  if (!command) usage('a subcommand is required');
  const args = parseArgs(rest);

  if (command === 'patterns') {
    /* Exists so a test can prove the shipped code and the contract agree, which is the one
     * form of drift no other assertion here would catch. */
    process.stdout.write(JSON.stringify({ packages: PKG_PATTERN, nodes: NODE_PATTERN }) + '\n');
    return;
  }

  if (command === 'validate') {
    const body = readDenylist(args.denylist);
    process.stderr.write('denylist OK: ' + body.packages.length + ' package(s), ' +
      body.nodes.length + ' node type(s) blocked\n');
    return;
  }

  if (command === 'nodes-exclude') {
    const body = readDenylist(args.denylist);
    /* THE BASELINE IS WHATEVER THE DEPLOYMENT ALREADY DECLARES, passed in via --baseline
     * from the live NODES_EXCLUDE. It is NOT a hardcoded list, and getting that wrong took
     * dev down: this used to seed the merge with N8N_DEFAULT_EXCLUDED_NODES, which meant a
     * denylist with no node blocks at all still emitted
     *   ["n8n-nodes-base.executeCommand","n8n-nodes-base.localFileTrigger"]
     * and overwrote the `NODES_EXCLUDE = "[]"` that terraform/sources/ecs-cluster/
     * task-definition.tf has always set. Those two node types were deliberately AVAILABLE in
     * this deployment; the post-upgrade smoke workflow uses executeCommand, and it began
     * answering HTTP 400 "Unrecognized node type" the moment this shipped.
     *
     * So the rule is: the operator brake only ever ADDS exclusions to what is already
     * configured. It never invents one. An empty result is legitimate and means exactly what
     * the deployment already said - exclude nothing.
     *
     * Still a JSON array and never a comma list: n8n parses this with a JsonStringArray that
     * returns [] on any parse failure, silently, so a malformed value excludes nothing while
     * looking like it worked. */
    const merged = parseBaselineNodes(args.baseline);
    for (const node of body.nodes) if (!merged.includes(node)) merged.push(node);
    process.stdout.write(JSON.stringify(merged));
    return;
  }

  if (command === 'merge') {
    const body = readDenylist(args.denylist);
    if (!args.config) usage('--config is required for merge');
    let config;
    try {
      config = JSON.parse(fs.readFileSync(args.config, 'utf8'));
    } catch (e) {
      refuse(['cannot read the runner config at ' + args.config + ': ' + e.message]);
    }
    const { config: merged, removed } = mergeConfig(config, body.packages);
    const rendered = JSON.stringify(merged, null, 2) + '\n';
    if (args.out) {
      fs.writeFileSync(args.out, rendered);
    } else {
      process.stdout.write(rendered);
    }
    /* The audit line goes to stderr so it lands in the container log next to the launcher's
     * own output without contaminating a piped config. */
    if (removed.length) {
      process.stderr.write('denylist applied - removed ' + removed.length + ' allowlist entr' +
        (removed.length === 1 ? 'y' : 'ies') + ': ' + removed.join(', ') + '\n');
    } else {
      process.stderr.write('denylist applied - nothing on the allowlists was blocked' +
        (body.packages.length ? ' (' + body.packages.length + ' name(s) denied, none were allowed anyway)' : '') + '\n');
    }
    return;
  }

  usage('unknown subcommand: ' + command);
}

if (require.main === module) main();

module.exports = {
  validateDenylist, mergeConfig, PKG_PATTERN, NODE_PATTERN, ALLOWLIST_KEYS,
  parseBaselineNodes,
};
