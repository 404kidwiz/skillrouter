#!/bin/bash
# End-to-end smoke of the reliability work, through the real CLI, hook launcher, warm service and MCP server.
# Everything runs in a scratch home and from a scratch copy of this checkout: your real home, configs and this
# checkout are not touched. Usage: npm run build && bash scripts/smoke-reliability.sh
SRC=$(cd "$(dirname "$0")/.." && pwd)
# Under /tmp whatever TMPDIR says: the paths below are used unquoted and must not contain spaces.
S=$(mktemp -d /tmp/skillrouter-smoke.XXXXXX) || exit 1; S=$(cd "$S" && pwd -P)
case "$S" in *" "*) echo "temp dir has a space: $S"; exit 1;; esac
A=$S/.skillrouter/app/current/dist/src/cli.js
# On any exit, also an interrupted one: stop the service this script started, then remove everything it made.
trap '[ -f "$A" ] && HOME="$S" SKILLROUTER_HOME="$S/.skillrouter" node "$A" service stop >/dev/null 2>&1; rm -rf "$S"' EXIT
trap 'exit 130' INT TERM
REPO=$S/checkout; mkdir -p $REPO/.git
cp -R "$SRC/dist" "$SRC/eval" "$SRC/package.json" $REPO/ && ln -s "$SRC/node_modules" $REPO/node_modules
CLI=$REPO/dist/src/cli.js
export HOME=$S USERPROFILE=$S SKILLROUTER_HOME=$S/.skillrouter SKILLROUTER_SERVICE_IDLE_MIN=1
# Each host's gate is checked with the same task text and no search, which the stall cap (recurring.ts) would let
# through after two runs; the cap has its own tests (test/batch19).
export SKILLROUTER_GATE_STALL_RUNS=0
unset SKILLROUTER_NODE SKILLROUTER_WEAK SKILLROUTER_SNAPSHOT SKILLROUTER_GATE SKILLROUTER_LOG_MAX_MB
pass=0; fail=0
ok(){ if [ "$1" = 0 ]; then pass=$((pass+1)); echo "PASS  $2"; else fail=$((fail+1)); echo "FAIL  $2"; fi; }
has(){ echo "$1" | grep -qE "$2"; }
# library: bundled fixture + two skills that make a weak-only query
mkdir -p $S/lib/vercel-deployment $S/lib/redis-patterns
printf -- '---\nname: vercel-deployment\ndescription: Deploy Next.js applications to Vercel with environment configuration and custom domains.\n---\nbody\n' > $S/lib/vercel-deployment/SKILL.md
printf -- '---\nname: redis-patterns\ndescription: Redis caching patterns, distributed locks and rate limiting for backend services.\n---\nbody\n' > $S/lib/redis-patterns/SKILL.md
SKILLROUTER_SERVICE=0 node $CLI index --root $REPO/eval/skills --root $S/lib >/dev/null 2>&1; ok $? "index builds (fixture + 2 skills)"

echo "== 1 search tiers (CLI)"
o=$(SKILLROUTER_SERVICE=0 node $CLI search "write python pytest regression tests" --lexical); has "$o" "relevant\)"; ok $? "strong match is labeled relevant"
o=$(SKILLROUTER_SERVICE=0 node $CLI search "custom services and patterns" --lexical); echo "$o" | head -3 | cut -c1-150
has "$o" "^No strong match\. Weak candidates follow" && has "$o" "; weak\)"; ok $? "no strong match -> labeled weak candidates"
o=$(SKILLROUTER_SERVICE=0 SKILLROUTER_WEAK=0 node $CLI search "custom services and patterns" --lexical); has "$o" "^No matching skills"; ok $? "SKILLROUTER_WEAK=0 -> nothing"
o=$(SKILLROUTER_SERVICE=0 node $CLI search "zzqx blorptang" --lexical); has "$o" "^No matching skills"; ok $? "gibberish -> nothing"
o=$(SKILLROUTER_SERVICE=0 node $CLI explain "custom services and patterns" --lexical); has "$o" "weak tier, no strong match" && has "$o" "^WEAK "; ok $? "explain names the weak tier"

echo "== 3/4 install: private copy, pins, launcher"
mkdir -p $S/.hermes/profiles/alpha
printf 'model: x\nmcp_servers:\n  skillrouter:\n    command: /gone/node/26.13.1/bin/node\n    args:\n      - /gone/dist/src/cli.js\n      - mcp\n    env:\n      SKILLROUTER_AGENT: hermes\n' > $S/.hermes/profiles/alpha/config.yaml
printf 'model: x\n' > $S/.hermes/config.yaml
o=$(node $CLI install 2>&1); echo "$o" | head -2 | cut -c1-200
has "$o" "^Code: $S/.skillrouter/app/current/dist/src/cli.js -> "; ok $? "install makes a private copy and points at app/current"
A=$S/.skillrouter/app/current/dist/src/cli.js
[ -f "$A" ] && [ -L $S/.skillrouter/app/current ]; ok $? "app/current is a link to a complete copy"
grep -q "$A" $S/.codex/config.toml && grep -q "$A" $S/.cursor/mcp.json && grep -q "$A" $S/.gemini/settings.json && grep -q "$A" $S/.config/opencode/opencode.json && grep -q "$A" $S/.claude.json && grep -q "$A" $S/.openclaude.json && grep -q "$A" $S/.gemini/config/mcp_config.json; ok $? "all 7 JSON/TOML host configs point at the copy"
grep -q "$A" $S/.hermes/profiles/alpha/config.yaml && ! grep -q "/gone/" $S/.hermes/profiles/alpha/config.yaml; ok $? "Hermes profile repointed"
L=$S/.skillrouter/bin/skillrouter-hint
grep -q "^NODE='" $L && grep -q "$A" $L; ok $? "launcher pins a Node and runs the copy"
# rebuild isolation: change the checkout's compiled file, the copy must not change
echo "// rebuilt" >> $REPO/dist/src/routing.js
! grep -q "// rebuilt" $S/.skillrouter/app/current/dist/src/routing.js; ok $? "a rebuild in the checkout does not reach the installed copy"

o=$(SKILLROUTER_SERVICE=0 node $A doctor 2>&1); [ "$(echo "$o" | grep -c "hooks are configured but none ran")" = 5 ]; ok $? "doctor: notes all 5 hook hosts as configured but silent before any hook runs"
echo "== hooks through the launcher (each agent, each mode), service off"
for a in claude codex cursor gemini opencode; do
  for m in "" gate tool stop; do
    p='{"session_id":"s1","prompt_id":"p1","prompt":"write python pytest regression tests for the parser module","tool_name":"Bash","tool_input":{"command":"npm test"}}'
    echo "$p" | SKILLROUTER_SERVICE=0 $L $a $m >$S/h.out 2>$S/h.err; rc=$?
    [ $rc = 0 ] || { echo "   $a '$m' rc=$rc $(head -c 200 $S/h.err)"; }
    ok $rc "hook $a ${m:-prompt} exits 0"
  done
done
o=$(echo '{"session_id":"s2","prompt_id":"p2","prompt":"write python pytest regression tests for the parser module"}' | SKILLROUTER_SERVICE=0 $L codex); has "$o" "Skill check \(skillrouter\)"; ok $? "prompt hook shows a skill check"
o=$(echo '{"session_id":"s2","turn_id":"p2","tool_name":"Bash","tool_input":{"command":"npm install left-pad"}}' | SKILLROUTER_SERVICE=0 $L codex gate); has "$o" "permissionDecision\":\"deny"; ok $? "search gate refuses the first work call"
echo "== Hermes and Antigravity hooks through the launcher, in each host's own payload and answer shapes"
HP='{"hook_event_name":"pre_llm_call","tool_name":null,"tool_input":null,"session_id":"hs1","cwd":"/w","profile":"default","extra":{"turn_id":"t1","user_message":"write python pytest regression tests for the parser module"}}'
hg(){ printf '{"hook_event_name":"pre_tool_call","tool_name":"%s","tool_input":%s,"session_id":"hs1","cwd":"/w","extra":{"turn_id":"t1","tool_call_id":"%s"}}' "$1" "$2" "$3"; }
o=$(echo "$HP" | SKILLROUTER_SERVICE=0 $L hermes); has "$o" '^\{"context":"Skill check \(skillrouter\)'; ok $? "hermes pre_llm_call -> {context}"
o=$(hg terminal '{"command":"ls -la"}' c0 | SKILLROUTER_SERVICE=0 $L hermes gate); [ "$o" = "{}" ]; ok $? "hermes: read-only command passes"
o=$(hg terminal '{"command":"npm install left-pad"}' c1 | SKILLROUTER_SERVICE=0 $L hermes gate); has "$o" '^\{"decision":"block","reason":"skillrouter:'; ok $? "hermes pre_tool_call -> block until a search"
o=$(hg mcp_skillrouter_search_skills '{"query":"pytest"}' c2 | SKILLROUTER_SERVICE=0 $L hermes gate); [ "$o" = "{}" ]; ok $? "hermes: the router search is seen"
o=$(hg write_file '{"path":"/w/a.py","content":"x"}' c3 | SKILLROUTER_SERVICE=0 $L hermes gate); [ "$o" = "{}" ]; ok $? "hermes: work passes after the search"
AP='{"conversationId":"ag1","workspacePaths":["/w"],"lastUserInput":"write python pytest regression tests for the parser module","invocationNum":0}'
ag(){ printf '{"conversationId":"ag1","workspacePaths":["/w"],"lastUserInput":"write python pytest regression tests for the parser module","stepIdx":%s,"toolCall":{"name":"%s","args":%s}}' "$3" "$1" "$2"; }
o=$(echo "$AP" | SKILLROUTER_SERVICE=0 $L antigravity); has "$o" '^\{"injectSteps":\[\{"systemMessage":\{"systemMessage":"Skill check \(skillrouter\)'; ok $? "antigravity PreInvocation -> {injectSteps}"
o=$(echo "$AP" | SKILLROUTER_SERVICE=0 $L antigravity); [ "$o" = "{}" ]; ok $? "antigravity: later model calls of the turn add nothing"
o=$(ag view_file '{"AbsolutePath":"/w/a"}' 1 | SKILLROUTER_SERVICE=0 $L antigravity gate); [ "$o" = '{"decision":"allow"}' ]; ok $? "antigravity: a read is allowed, with an explicit decision"
o=$(ag run_command '{"CommandLine":"npm install left-pad"}' 2 | SKILLROUTER_SERVICE=0 $L antigravity gate); has "$o" '^\{"decision":"deny","reason":"skillrouter:'; ok $? "antigravity PreToolUse -> deny until a search"
o=$(ag mcp_skillrouter_search_skills '{"query":"pytest"}' 3 | SKILLROUTER_SERVICE=0 $L antigravity gate); [ "$o" = '{"decision":"allow"}' ]; ok $? "antigravity: the router search is seen"
o=$(ag write_to_file '{"TargetFile":"/w/a.py"}' 4 | SKILLROUTER_SERVICE=0 $L antigravity gate); [ "$o" = '{"decision":"allow"}' ]; ok $? "antigravity: work passes after the search"
o=$(echo 'garbage' | SKILLROUTER_SERVICE=0 $L antigravity gate); [ "$o" = '{"decision":"allow"}' ]; ok $? "antigravity: unreadable input still gets a decision"
o=$(node $CLI install antigravity --hooks 2>&1); has "$o" "skillrouter hooks set" && grep -q "skillrouter-hint' antigravity gate" $S/.gemini/config/hooks.json; ok $? "install antigravity --hooks writes hooks.json"
PY=$(command -v python3 || true)
if [ -n "$PY" ]; then
  # A stand-in for Hermes's config package (JSON is valid YAML), so install's real code path runs: Hermes's Python, per home.
  mkdir -p $S/.hermes/hermes-agent/hermes_cli $S/.hermes/profiles/beta
  : > $S/.hermes/hermes-agent/hermes_cli/__init__.py
  printf 'import json, os\ndef _p(): return os.path.join(os.environ["HERMES_HOME"], "config.yaml")\ndef load_config():\n    with open(_p()) as f: return json.load(f)\ndef save_config(c):\n    with open(_p(), "w") as f: json.dump(c, f, indent=2)\n' > $S/.hermes/hermes-agent/hermes_cli/config.py
  cp $S/.hermes/config.yaml $S/hermes-main.keep; cp $S/.hermes/profiles/alpha/config.yaml $S/hermes-alpha.keep
  echo '{"model":"x","hooks":{"post_tool_call":[{"command":"/mine/format.sh"}]}}' > $S/.hermes/config.yaml
  echo '{"model":"alpha"}' > $S/.hermes/profiles/alpha/config.yaml; echo '{"model":"beta"}' > $S/.hermes/profiles/beta/config.yaml
  o=$(SKILLROUTER_HERMES_PYTHON=$PY node $CLI install hermes --accept-hooks 2>&1)
  has "$o" "set via Hermes config API for main, alpha, beta" && has "$o" "Hermes hooks approved"; ok $? "install hermes --accept-hooks: main and profiles through Hermes's Python"
  grep -q "skillrouter-hint' hermes gate" $S/.hermes/profiles/beta/config.yaml && grep -q "/mine/format.sh" $S/.hermes/config.yaml && grep -q '"pre_llm_call"' $S/.hermes/shell-hooks-allowlist.json && grep -q '"pre_tool_call"' $S/.hermes/profiles/alpha/shell-hooks-allowlist.json; ok $? "hermes: hooks written beside the user's own, consent recorded per home"
  o=$(SKILLROUTER_SERVICE=0 node $A doctor 2>&1); has "$o" "hermes: hooks configured: prompt check \+ search gate; approved in Hermes" && has "$o" "antigravity: hooks configured: prompt check \+ search gate"; ok $? "doctor reports both hosts' hooks"
  cp $S/hermes-main.keep $S/.hermes/config.yaml; cp $S/hermes-alpha.keep $S/.hermes/profiles/alpha/config.yaml; rm -rf $S/.hermes/hermes-agent $S/.hermes/profiles/beta
else echo "SKIP  no python3: install hermes not exercised"; fi

echo "== 3 launcher fallback when the pinned Node is gone"
sed "s#^NODE='[^']*'#NODE='/gone/node/26.13.1/bin/node'#" $L > $S/launcher-broken && chmod +x $S/launcher-broken
o=$(echo '{"session_id":"s3","prompt_id":"p3","prompt":"write python pytest regression tests for the parser module"}' | SKILLROUTER_SERVICE=0 $S/launcher-broken codex); rc=$?; [ $rc = 0 ] && has "$o" "Skill check"; ok $? "broken pin: hook still answers via fallback Node"

echo "== warm service through the launcher"
if command -v perl >/dev/null; then
  o=$(echo '{"hook_event_name":"pre_llm_call","session_id":"hs7","extra":{"turn_id":"t7","user_message":"write python pytest regression tests for the parser module"}}' | $L hermes); sleep 3
  o=$(echo '{"hook_event_name":"pre_llm_call","session_id":"hs8","extra":{"turn_id":"t8","user_message":"write python pytest regression tests for the lexer module"}}' | $L hermes); has "$o" '^\{"context":"Skill check'; ok $? "hermes hook answered through the warm service"
  o=$(echo '{"conversationId":"ag8","lastUserInput":"x","stepIdx":1,"toolCall":{"name":"view_file","args":{}}}' | $L antigravity gate); [ "$o" = '{"decision":"allow"}' ]; ok $? "antigravity gate answered through the warm service"
  o=$(echo '{"session_id":"s4","prompt_id":"p4","prompt":"write python pytest regression tests for the parser module"}' | $L codex); sleep 3
  o=$(echo '{"session_id":"s4","prompt_id":"p5","prompt":"write python pytest regression tests for the parser module again"}' | $L codex); has "$o" "Skill check"; ok $? "hook answers with the service enabled"
  o=$(node $A service status 2>&1); echo "   $o" | head -2 | cut -c1-160; has "$o" "running"; ok $? "service is running from the copy"
  node $A service stop >/dev/null 2>&1; o=$(node $A service status 2>&1); has "$o" "not running"; ok $? "service stops"
else echo "SKIP  no perl"; fi

echo "== doctor"
o=$(SKILLROUTER_SERVICE=0 node $A doctor --live 2>&1)
has "$o" "^Pins: [0-9]+ configured Node and code paths exist and are stable"; ok $? "doctor: pins clean after install"
n=$(echo "$o" | grep -c "connected in"); [ "$n" = 7 ]; ok $? "doctor --live: 7 hosts connect from the copy (got $n; hermes main config has no entry here)"
has "$o" "^Disk: usage log"; ok $? "doctor: disk line"
! has "$o" "hooks are configured but none ran"; ok $? "doctor: no silent-host note once every host's hook has run"
printf 'model: x\nmcp_servers:\n  skillrouter:\n    command: /gone/node/26.13.1/bin/node\n    args:\n      - /gone/dist/src/cli.js\n      - mcp\n' > $S/.hermes/config.yaml
o=$(SKILLROUTER_SERVICE=0 node $A doctor 2>&1); has "$o" "hermes MCP: Node /gone/node/26.13.1/bin/node is missing" && has "$o" "different copies of the code"; ok $? "doctor: flags a stale pin and mixed code copies"

echo "== 1/2 MCP server over stdio (from the copy)"
cat > $S/mcp.mjs <<'J'
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import fs from 'node:fs';
const [cli, sr] = process.argv.slice(2);
const env = { ...process.env, SKILLROUTER_AGENT: 'codex', SKILLROUTER_SERVICE: '0' };
const c = new Client({ name: 'smoke', version: '1' });
await c.connect(new StdioClientTransport({ command: process.execPath, args: [cli, 'mcp'], env }));
const t = async (name, args) => (await c.callTool({ name, arguments: args })).content.map(x => x.text).join('\n');
const out = {};
out.strong = /relevant\)/.test(await t('search_skills', { query: 'write python pytest regression tests' }));
const weak = await t('search_skills', { query: 'custom services and patterns' });
out.weak = /^No strong match\. Weak candidates follow/.test(weak) && /; weak\)/.test(weak);
const id = weak.match(/^- (\S+)/m)?.[1];
out.readWeak = !!id && /^--- /.test(await t('read_skill', { id }));
out.none = /^No matching skills/.test(await t('search_skills', { query: 'zzqx blorptang' }));
// retire the bare name of a skill: reserve it for an identity that is gone, keep the skill as ~2
const f = sr + '/index.json'; const ix = JSON.parse(fs.readFileSync(f, 'utf8'));
const s = ix.skills.find(x => x.name === 'redis-patterns'); s.id = 'redis-patterns~2'; s.aliases = [];
ix.identityAliases = { ...(ix.identityAliases ?? {}), 'redis-patterns': 'redis-patterns@retired000000000000000000' };
fs.writeFileSync(f, JSON.stringify(ix)); await new Promise(r => setTimeout(r, 50));
const retired = await t('read_skill', { id: 'redis-patterns' });
out.retired = /^--- redis-patterns~2 /.test(retired) && /the name 'redis-patterns' was retired/.test(retired);   // also proves the running server reloads the index
out.unknown = /not found/.test(await t('read_skill', { id: 'no-such-skill' }));
await c.close();
const rows = fs.readFileSync(sr + '/usage.jsonl', 'utf8').trim().split('\n').map(JSON.parse);
out.logWeak = rows.some(r => r.tool === 'search_skills' && r.weak === true && r.agent === 'codex');
console.log(JSON.stringify(out));
J
cp $S/mcp.mjs $REPO/.smoke-mcp.mjs; o=$(node $REPO/.smoke-mcp.mjs $A $S/.skillrouter 2>&1); echo "   $o" | cut -c1-300
for k in strong weak readWeak none retired unknown logWeak; do has "$o" "\"$k\":true"; ok $? "MCP: $k"; done

echo "== 5/6 report gaps and log rotation"
for i in 1 2 3 4; do echo "{\"ts\":\"$(date -u +%Y-%m-%dT%H:%M:%S.000Z)\",\"client\":\"codex-mcp-client/1\",\"agent\":\"codex\",\"tool\":\"search_skills\",\"query\":\"read-only production website integrity verification TLS run $i\",\"hits\":[]}" >> $S/.skillrouter/usage.jsonl; done
for i in 1 2 3; do echo "{\"ts\":\"$(date -u +%Y-%m-%dT%H:%M:%S.000Z)\",\"client\":\"codex-mcp-client/1\",\"agent\":\"codex\",\"tool\":\"read_skill\",\"skill\":\"prompt-mini\",\"found\":false}" >> $S/.skillrouter/usage.jsonl; done
o=$(SKILLROUTER_SERVICE=0 node $A report 7 2>&1)
has "$o" "^Searches: [0-9]+; [0-9]+ with a strong match, [0-9]+ with weak candidates only, [0-9]+ with nothing"; ok $? "report: search outcome line"
has "$o" "Skill gaps" && has "$o" " 4  codex: read-only production website integrity"; ok $? "report: repeated empty search listed as a gap"
has "$o" " 3  prompt-mini"; ok $? "report: unknown skill name listed"
before=$(SKILLROUTER_SERVICE=0 node $A report 7 2>&1 | grep -c .)
o=$(echo '{"session_id":"s9","prompt_id":"p9","prompt":"write python pytest regression tests for the parser module"}' | SKILLROUTER_SERVICE=0 SKILLROUTER_LOG_MAX_MB=0.001 $L codex)
ls $S/.skillrouter/usage.*.jsonl >/dev/null 2>&1; ok $? "usage log rotates past the limit"
o=$(SKILLROUTER_SERVICE=0 node $A report 7 2>&1); has "$o" " 4  codex: read-only production website integrity"; ok $? "report still reads rows from the rotated log"

echo "== a recurring request remembers the skill it used"
RJ(){ printf '{"session_id":"rj%s","turn_id":"t%s","prompt":"Nightly run %s: confirm the storefront answers and nothing drifted since yesterday evening."}' "$1" "$1" "$1"; }
RL(){ printf '{"session_id":"rj%s","turn_id":"t%s","tool_use_id":"r","tool_name":"mcp__skillrouter__read_skill","tool_input":{"id":"smoke-load"}}' "$1" "$1"; }
mkdir -p $S/lib/smoke-load; printf -- '---\nname: smoke-load\ndescription: Kiln glaze schedule for stoneware pottery firing and cooling curves.\n---\nbody\n' > $S/lib/smoke-load/SKILL.md
SKILLROUTER_SERVICE=0 node $A index >/dev/null 2>&1
for n in 1 2; do RJ $n | SKILLROUTER_SERVICE=0 $L codex >/dev/null; RL $n | SKILLROUTER_SERVICE=0 $L codex gate >/dev/null; done
o=$(RJ 3 | SKILLROUTER_SERVICE=0 $L codex); has "$o" "A request worded like this one was answered before with: smoke-load"; ok $? "third run of the same request is told the skill at once"
o=$(SKILLROUTER_SERVICE=0 node $A recurring 2>&1); has "$o" "3 runs .*smoke-load x2" && ! has "$o" "storefront"; ok $? "recurring lists runs and skills, not the request's words"
HD='{"hook_event_name":"post_llm_call","session_id":"hs1","extra":{"turn_id":"t1","assistant_response":"Done. Skills: none (nothing fit)"}}'
o=$(echo "$HD" | SKILLROUTER_SERVICE=0 $L hermes decision); [ "$o" = "{}" ]; ok $? "hermes post_llm_call is answered with an empty object"

echo "== backups"
B=$S/.skillrouter/backups; mkdir -p $B/old-rules $B/new-rules; echo x > $B/old-rules/a; echo x > $B/new-rules/a
touch -t 202001010000 $B/old-rules/a $B/old-rules
o=$(SKILLROUTER_SERVICE=0 node $A backups 2>&1); has "$o" "would remove  old-rules" && has "$o" "keep \(newer than 30 days\)  new-rules" && [ -d $B/old-rules ]; ok $? "backups: dry run lists, removes nothing"
o=$(SKILLROUTER_SERVICE=0 node $A backups --apply 2>&1); has "$o" "REMOVED  old-rules" && [ ! -d $B/old-rules ] && [ -d $B/new-rules ]; ok $? "backups --apply removes only what is old"

echo "== upgrade: second install switches the copy, configs keep one path"
first=$(readlink $S/.skillrouter/app/current); echo "// v2" >> $REPO/dist/src/routing.js
node $CLI install >/dev/null 2>&1; second=$(readlink $S/.skillrouter/app/current)
[ "$first" != "$second" ] && grep -q "// v2" $S/.skillrouter/app/current/dist/src/routing.js && grep -q "$A" $S/.codex/config.toml && [ -d $S/.skillrouter/app/$first ]; ok $? "reinstall switches copies; previous copy kept; config path unchanged"
[ "$(grep -c skillrouter-hint $S/.codex/hooks.json)" = 4 ]; ok $? "reinstall leaves exactly 4 Codex hooks"
node $A service stop >/dev/null 2>&1
echo; echo "RESULT pass=$pass fail=$fail"; [ $fail = 0 ]
